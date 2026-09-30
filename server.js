// sessiondeck: a web cockpit for Claude Code sessions running in tmux, shown through ttyd.
const express = require('express');
const { spawn, execFile, execFileSync } = require('child_process');
const httpProxy = require('http-proxy');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { isValidId, UUID_RE, resolveWorkdir, checkBasicAuth, sameOrigin } = require('./guard');
const { readPane } = require('./pane');
const { shouldRevive, conversationsFromPidFiles, NUDGE } = require('./revive');

// ── Configuration (environment variables, see .env.example) ─────────
const env = process.env;
// Started from inside tmux, $TMUX would point every child tmux call (and every ttyd
// attach) at the caller's own tmux server instead of the one sessiondeck manages.
delete env.TMUX;
delete env.TMUX_PANE;
const fail = msg => { console.error(`sessiondeck: ${msg}`); process.exit(1); };

const CONFIG = {
  user: env.SESSIONDECK_USER || 'admin',
  password: env.SESSIONDECK_PASSWORD || '',
  host: env.SESSIONDECK_HOST || '127.0.0.1',
  port: +env.SESSIONDECK_PORT || 8765,
  root: path.resolve(env.SESSIONDECK_ROOT || path.join(os.homedir(), 'projects')),
  ttydBin: env.SESSIONDECK_TTYD_BIN || 'ttyd',
  ttydPortStart: +env.SESSIONDECK_TTYD_PORT_START || 9100,
  claudeBin: env.SESSIONDECK_CLAUDE_BIN || 'claude',
  runAsUser: env.SESSIONDECK_RUN_AS || '',
  dataDir: path.resolve(env.SESSIONDECK_DATA_DIR || path.join(__dirname, 'data')),
  uploadDir: env.SESSIONDECK_UPLOAD_DIR ? path.resolve(env.SESSIONDECK_UPLOAD_DIR) : '',
  name: env.SESSIONDECK_NAME || os.hostname(),
};

// Keep the password out of the environment every child inherits (tmux server, claude, ttyd).
delete env.SESSIONDECK_PASSWORD;

if (CONFIG.password.length < 12) {
  fail('SESSIONDECK_PASSWORD is not set or shorter than 12 characters. There is no default password.\n' +
    '  Generate one, for example:  export SESSIONDECK_PASSWORD="$(openssl rand -base64 24)"');
}
if (!fs.existsSync(CONFIG.root) || !fs.statSync(CONFIG.root).isDirectory()) {
  fail(`projects root ${CONFIG.root} does not exist. Set SESSIONDECK_ROOT to your projects folder.`);
}
const isRoot = process.getuid() === 0;
if (isRoot && !CONFIG.runAsUser) {
  fail('running as root without SESSIONDECK_RUN_AS. Run sessiondeck as a normal user (recommended) ' +
    'or set SESSIONDECK_RUN_AS to the user the Claude sessions should run as.');
}
if (CONFIG.runAsUser && !/^[a-z_][a-z0-9_-]{0,31}$/.test(CONFIG.runAsUser)) fail('SESSIONDECK_RUN_AS is not a valid user name');

// Home directory of the run-as user, read from /etc/passwd.
function homeOf(user) {
  const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find(l => l.startsWith(user + ':'));
  if (!line) fail(`user ${user} from SESSIONDECK_RUN_AS does not exist`);
  return line.split(':')[5];
}
const RUN_AS_HOME = isRoot ? homeOf(CONFIG.runAsUser) : null;
// Dropped images: by default in the private data dir. In root mode the run-as user must be
// able to read them, so they go to a folder in the run-as user's home instead.
if (!CONFIG.uploadDir) {
  CONFIG.uploadDir = isRoot ? path.join(RUN_AS_HOME, '.cache', 'sessiondeck-images') : path.join(CONFIG.dataDir, 'images');
}

fs.mkdirSync(CONFIG.dataDir, { recursive: true, mode: 0o700 });
const SESSIONS_FILE = path.join(CONFIG.dataDir, 'sessions.json');
const ACTIVITY_FILE = path.join(CONFIG.dataDir, 'activity.json');
const UPDATES_FILE = path.join(CONFIG.dataDir, 'updates.json');
// Claude Code writes ~/.claude/sessions/<pid>.json per running process, with tmux session and conversation id.
const PID_DIR = path.join(RUN_AS_HOME || os.homedir(), '.claude', 'sessions');

// ── tmux, as the configured user ────────────────────────────────────
// When sessiondeck runs as root, every tmux call is dropped to SESSIONDECK_RUN_AS.
// Arguments are passed as an array, never through a shell.
function tmuxCmd(args) {
  return isRoot
    ? ['runuser', ['-u', CONFIG.runAsUser, '--', 'env', `HOME=${RUN_AS_HOME}`, 'tmux', ...args]]
    : ['tmux', args];
}
const tmuxSync = args => execFileSync(...tmuxCmd(args), { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
const tmuxRaw = args => new Promise(res =>
  execFile(...tmuxCmd(args), { timeout: 5000, maxBuffer: 1 << 20 }, (err, out, stderr) => res({ err, out, stderr })));
const tmuxAsync = args => tmuxRaw(args).then(r => (r.err ? null : r.out));

// POSIX single-quote escaping, only used for the one su -c string below.
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Command ttyd runs to attach to a session. su --pty is required in root mode: without its
// own terminal the tmux client never gets SIGWINCH and keeps the size from connect time.
function attachCommand(id) {
  if (!isValidId(id)) throw new Error('invalid session id');
  return isRoot
    ? ['su', '--pty', '-s', '/bin/sh', CONFIG.runAsUser, '-c', `HOME=${shq(RUN_AS_HOME)} exec tmux attach-session -t ${id}`]
    : ['tmux', 'attach-session', '-t', id];
}

// ── Sessions ────────────────────────────────────────────────────────
const sessions = Object.create(null);
let portCounter = CONFIG.ttydPortStart;

function saveSessions() {
  const data = Object.values(sessions).map(s => ({
    id: s.id, name: s.name, cwd: s.cwd, port: s.port, ttydAuth: s.ttydAuth,
    createdAt: s.createdAt, status: s.status,
    claude: s.claude, tmuxStart: s.tmuxStart, wasWorking: s.wasWorking,
  }));
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 }); }
  catch (e) { console.error('saveSessions:', e.message); }
}

function nextPort() {
  while (Object.values(sessions).some(s => s.port === portCounter)) portCounter++;
  return portCounter++;
}

function getProjects() {
  try {
    return fs.readdirSync(CONFIG.root, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map(d => d.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  } catch { return []; }
}

const projectOf = cwd => path.relative(fs.realpathSync(CONFIG.root), cwd);

// Labels the tmux status bar and the terminal window title with session and project name,
// so several open terminal windows can be told apart.
function labelTmuxSession(id, name, workdir) {
  const label = `${name} · ${projectOf(workdir) || 'all projects'}`;
  const opts = [
    ['status-left', `#[bold] ${label.replace(/#/g, '##')} #[default]`],
    ['status-left-length', '60'],
    ['set-titles', 'on'],
    ['set-titles-string', label.replace(/#/g, '##')],
  ];
  for (const [key, value] of opts) {
    try { tmuxSync(['set-option', '-t', id, key, value]); }
    catch (err) { console.error(`[tmux label ${id}] ${key}: ${err.message}`); }
  }
}

function spawnTtyd(s) {
  const proc = spawn(CONFIG.ttydBin, [
    '--writable', '--port', String(s.port), '--interface', '127.0.0.1',
    // Per-session random credential: other local users cannot attach to the ttyd port
    // directly. The proxy below injects it; browsers never see it.
    '--credential', `sessiondeck:${s.ttydAuth}`,
    ...attachCommand(s.id),
  ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.unref();
  proc.stdout.on('data', d => console.log(`[ttyd ${s.id}] ${d.toString().trim()}`));
  proc.stderr.on('data', d => console.log(`[ttyd ${s.id}] ${d.toString().trim()}`));
  proc.on('error', err => console.error(`[ttyd ${s.id}] error:`, err.message));
  proc.on('exit', code => {
    console.log(`[ttyd ${s.id}] exited ${code}`);
    if (sessions[s.id]) sessions[s.id].status = 'stopped';
  });
  return proc;
}

// Mouse reporting stays on so the wheel scrolls; selecting text then needs Alt or Shift.
// env -u: new sessions inherit the environment of the long-running tmux server, an old
// CLAUDE_CODE_DISABLE_MOUSE there would otherwise kill the wheel in fresh sessions too.
function tmuxNew(id, workdir, resume) {
  tmuxSync(['new-session', '-d', '-s', id, '-c', workdir,
    'env', '-u', 'CLAUDE_CODE_DISABLE_MOUSE', CONFIG.claudeBin, ...(resume ? ['--resume', resume] : [])]);
}

async function createSession(name, cwd, resume) {
  const workdir = resolveWorkdir(CONFIG.root, cwd);
  const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  // Continue numbering from the highest existing "Session N", not from the count:
  // after deleting one, the count would hand out a name that already exists.
  const maxNr = Math.max(0, ...Object.values(sessions)
    .map(s => Number((/^Session (\d+)$/.exec(s.name || '') || [])[1]) || 0));
  const sessionName = (typeof name === 'string' && name.trim().slice(0, 80)) || `Session ${maxNr + 1}`;

  tmuxNew(id, workdir, resume);
  labelTmuxSession(id, sessionName, workdir);

  const s = sessions[id] = {
    id, name: sessionName, cwd: workdir, port: nextPort(),
    ttydAuth: crypto.randomBytes(18).toString('base64url'),
    createdAt: new Date().toISOString(), status: 'running', claude: resume || null,
  };
  s.process = spawnTtyd(s);
  saveSessions();
  await new Promise(r => setTimeout(r, 500));
  return s;
}

// PID of the process listening on a local TCP port, via ss (no shell).
function pidOnPort(port) {
  try {
    const out = execFileSync('ss', ['-Htlnp', `sport = :${port}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const m = out.match(/pid=(\d+)/);
    return m ? +m[1] : null;
  } catch { return null; }
}

// The tmux session is the source of truth for the claude process; it lives independently of
// ttyd and of this server. kill-session ends claude in one step, also for sessions recovered
// after a restart where no process handle exists.
function killSession(s) {
  try { s.process?.kill('SIGTERM'); } catch {}
  if (isValidId(s.id)) { try { tmuxSync(['kill-session', '-t', s.id]); } catch {} }
  const pid = Number.isInteger(s.port) ? pidOnPort(s.port) : null;
  if (pid) {
    try {
      if (fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'ttyd') process.kill(pid, 'SIGTERM');
    } catch {}
  }
}

// ── Revive after a crash (see revive.js) ────────────────────────────
// Start time and session names of the tmux server. start null = no server (crash, reboot).
// undefined = no clear answer (for example a timeout under load), then better do nothing.
async function tmuxServer() {
  const r = await tmuxRaw(['list-sessions', '-F', '#{start_time} #{session_name}']);
  if (r.err) {
    return /no server running|error connecting/.test(r.stderr || '') ? { start: null, names: new Set() } : undefined;
  }
  const rows = r.out.trim().split('\n').filter(Boolean).map(l => l.split(' '));
  return { start: rows[0]?.[0] ?? null, names: new Set(rows.map(x => x[1])) };
}

function claudeConversations() {
  try {
    return conversationsFromPidFiles(fs.readdirSync(PID_DIR).filter(f => f.endsWith('.json')).map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(PID_DIR, f), 'utf8')); } catch { return null; }
    }));
  } catch { return {}; }
}

// ponytail: ending the very last session with /exit takes the tmux server with it, which looks
// like a crash. That one session comes back (harmless, it just sits idle).
function revive(s) {
  s.tmuxStart = null; // exactly one attempt, not one per round
  try { tmuxNew(s.id, resolveWorkdir(CONFIG.root, s.cwd), s.claude); }
  catch (e) { return console.error(`[revive ${s.id}]`, e.message); }
  labelTmuxSession(s.id, s.name, s.cwd);
  if (!pidOnPort(s.port)) s.process = spawnTtyd(s);
  // Only a session that was in the middle of work gets the nudge; one waiting for you keeps waiting.
  if (s.wasWorking) s.nudgeAt = Date.now();
  console.log(`[revive] ${s.id} (${s.name}) with conversation ${s.claude}`);
}

async function reviveRound() {
  const server = await tmuxServer();
  if (!server) return false;
  const conversations = claudeConversations();
  let changed = false;
  for (const s of Object.values(sessions)) {
    if (server.names.has(s.id)) {
      const claude = conversations[s.id] ?? s.claude;
      if (claude !== s.claude || server.start !== s.tmuxStart) {
        s.claude = claude; s.tmuxStart = server.start; changed = true;
      }
    } else if (shouldRevive(s, server.start)) {
      revive(s); changed = true;
    } else if (s.tmuxStart && s.tmuxStart === server.start) {
      // Gone while the server kept running = ended on purpose. Forget it, otherwise it would
      // come back with the next real crash.
      s.tmuxStart = null; changed = true;
    }
  }
  return changed;
}

// ── Looking into the terminals ──────────────────────────────────────
// Every few seconds the visible tmux content of each session is read: that gives the last
// lines for the card, the state (working / waiting for you / idle), open questions and the
// day strip. If the content changed, the session was active in that half hour.
const SLOT_MS = 30 * 60 * 1000;
let activity = {}; // id -> { slotNr: number of changes }
try { activity = JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8')); } catch {}
let activityDirty = false;
const peek = Object.create(null); // id -> readPane() result plus raw text and last change

// After finishing, a session counts as "waiting for you" for this long, then it is idle.
// ponytail: time window instead of a real read marker, tmux does not know what you have seen.
const WAITING_MS = 30 * 60 * 1000;

async function peekRound() {
  const now = Date.now(), slot = Math.floor(now / SLOT_MS);
  let save = await reviveRound();
  await Promise.all(Object.values(sessions).map(async s => {
    const text = await tmuxAsync(['capture-pane', '-p', '-t', s.id]);
    if (text === null) return;
    const old = peek[s.id];
    const next = { ...readPane(text), text, changed: old?.changed ?? now };
    // Keep the last artifact link even after it scrolled out of view.
    next.artifact ??= old?.artifact ?? null;
    if (old && old.text !== text) {
      next.changed = now;
      const a = activity[s.id] ||= {};
      a[slot] = (a[slot] || 0) + 1;
      activityDirty = true;
    }
    peek[s.id] = next;
    if (s.wasWorking !== next.working) { s.wasWorking = next.working; save = true; }
    // Nudge a revived session once its conversation has loaded: screen still, not working, no question.
    if (s.nudgeAt && now - s.nudgeAt > 20000 && old?.text === text && !next.working && !next.asking) {
      delete s.nudgeAt;
      await tmuxAsync(['send-keys', '-t', s.id, '-l', NUDGE]);
      await tmuxAsync(['send-keys', '-t', s.id, 'Enter']);
      console.log(`[revive] ${s.id} nudged`);
    }
  }));
  if (save) saveSessions();
}

// Save activity once a minute, dropping anything older than 48 hours and ended sessions.
function saveActivity() {
  if (!activityDirty) return;
  const limit = Math.floor(Date.now() / SLOT_MS) - 96;
  for (const [id, a] of Object.entries(activity)) {
    if (!sessions[id]) { delete activity[id]; continue; }
    for (const k of Object.keys(a)) if (+k < limit) delete a[k];
  }
  try { fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(activity), { mode: 0o600 }); activityDirty = false; }
  catch (e) { console.error('activity:', e.message); }
}

function stateOf(s) {
  const p = peek[s.id];
  if (!p || s.status !== 'running') return 'idle';
  if (p.asking) return 'waiting';
  if (p.working) return 'working';
  return Date.now() - p.changed < WAITING_MS ? 'waiting' : 'idle';
}

// Real CPU usage from /proc/stat deltas, one sample per minute, 30 samples.
const cpuHistory = [];
let cpuPrev = null;
function cpuSample() {
  try {
    const t = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = t[3] + (t[4] || 0), total = t.reduce((x, y) => x + y, 0);
    if (cpuPrev) {
      const d = total - cpuPrev.total;
      if (d > 0) cpuHistory.push(Math.round((1 - (idle - cpuPrev.idle) / d) * 100));
      if (cpuHistory.length > 30) cpuHistory.shift();
    }
    cpuPrev = { idle, total };
  } catch {}
}

// ── Updates for Claude Code and plugins (see check-updates.js) ───────
// Runs as the user that runs Claude Code, with a minimal environment. The result goes to the data dir.
let updateRun = null;
function runUpdates(apply) {
  if (updateRun) return updateRun;
  const script = path.join(__dirname, 'check-updates.js');
  const childEnv = { PATH: env.PATH, HOME: RUN_AS_HOME || os.homedir(), SESSIONDECK_CLAUDE_BIN: CONFIG.claudeBin };
  const args = [process.execPath, script, ...(apply ? ['--apply'] : [])];
  const [cmd, argv] = isRoot ? ['runuser', ['-u', CONFIG.runAsUser, '--', ...args]] : [args[0], args.slice(1)];
  updateRun = new Promise(resolve => {
    execFile(cmd, argv, { env: childEnv, timeout: 20 * 60 * 1000, maxBuffer: 1 << 20 }, (err, out) => {
      try {
        const data = JSON.parse(out);
        fs.writeFileSync(UPDATES_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
      } catch { console.error('updates:', err?.message || 'unreadable output'); }
      updateRun = null;
      resolve();
    });
  });
  return updateRun;
}

// ── HTTP ────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Authentication for everything, including static files and the terminal proxy.
function authorized(req) {
  return checkBasicAuth(req.headers.authorization, CONFIG.user, CONFIG.password);
}
app.use((req, res, next) => {
  if (authorized(req)) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="sessiondeck", charset="UTF-8"');
  res.status(401).send('Authentication required');
});

// CSRF: API writes need our own header (forces a CORS preflight, which is never answered)
// and, from browsers, a same-origin Origin header.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.headers['x-sessiondeck'] !== '1' || !sameOrigin(req.headers)) {
    return res.status(403).json({ error: 'cross-site request refused' });
  }
  next();
});
app.use('/api', express.json({ limit: '16kb' }));

const publicSession = s => ({
  id: s.id, name: s.name, project: projectOf(s.cwd), createdAt: s.createdAt, status: s.status,
  state: stateOf(s),
  lines: peek[s.id]?.lines || [],
  question: peek[s.id]?.question || null,
  contextPct: peek[s.id]?.contextPct ?? null,
  tokensK: peek[s.id]?.tokensK ?? null,
  artifact: peek[s.id]?.artifact ?? null,
  changed: peek[s.id]?.changed || null,
  activity: activity[s.id] || {},
});

app.get('/api/sessions', (req, res) => res.json(Object.values(sessions).map(publicSession)));

app.get('/api/projects', (req, res) => res.json(getProjects()));

app.get('/api/system', (req, res) => {
  try {
    const mem = Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n')
      .map(l => /^(\w+):\s+(\d+)/.exec(l)).filter(Boolean).map(m => [m[1], +m[2] * 1024]));
    const disk = fs.statfsSync(CONFIG.root);
    // Summed RSS of all ttyd processes (ps reports KB).
    let sessionRamBytes = 0;
    try {
      sessionRamBytes = execFileSync('ps', ['-C', 'ttyd', '-o', 'rss='], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().split('\n').reduce((sum, v) => sum + (+v || 0), 0) * 1024;
    } catch {}
    res.json({
      name: CONFIG.name, cores: os.cpus().length,
      cpuPct: Math.min(100, Math.round(os.loadavg()[0] / os.cpus().length * 100)), cpuHistory,
      memTotal: mem.MemTotal, memUsed: mem.MemTotal - mem.MemAvailable,
      diskTotal: disk.blocks * disk.bsize, diskUsed: (disk.blocks - disk.bavail) * disk.bsize,
      sessionRamBytes,
    });
  } catch (err) {
    console.error('system:', err.message);
    res.status(500).json({ error: 'system stats unavailable' });
  }
});

app.get('/api/updates', (req, res) => {
  let data = { items: [] };
  try { data = JSON.parse(fs.readFileSync(UPDATES_FILE, 'utf8')); } catch {}
  res.json({ ...data, running: !!updateRun });
});

app.post('/api/updates/:what(check|apply)', (req, res) => {
  if (updateRun) return res.status(409).json({ error: 'an update check is already running' });
  runUpdates(req.params.what === 'apply');
  res.json({ started: true });
});

app.post('/api/sessions', async (req, res) => {
  const { name, cwd, resume } = req.body || {};
  if (resume != null && !(typeof resume === 'string' && UUID_RE.test(resume))) {
    return res.status(400).json({ error: 'resume must be a conversation uuid' });
  }
  if (cwd != null && typeof cwd !== 'string') return res.status(400).json({ error: 'invalid cwd' });
  try {
    res.json(publicSession(await createSession(name, cwd, resume)));
  } catch (err) {
    console.error('createSession:', err.message);
    const known = /working directory/.test(err.message);
    res.status(known ? 400 : 500).json({ error: known ? err.message : 'could not start session, see server log' });
  }
});

app.delete('/api/sessions/:id', (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  killSession(s);
  delete sessions[s.id];
  delete peek[s.id];
  saveSessions();
  res.json({ ok: true });
});

// Answer an open question by pressing its number key in the session. Only numbers that the
// currently visible menu actually offers are accepted.
app.post('/api/sessions/:id/answer', (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  const nr = req.body?.option;
  const q = peek[s.id]?.question;
  if (!Number.isInteger(nr) || !q?.options.some(o => o.nr === nr) || nr > 9) {
    return res.status(409).json({ error: 'this option is not on screen any more' });
  }
  try { tmuxSync(['send-keys', '-t', s.id, String(nr)]); }
  catch (err) { console.error('answer:', err.message); return res.status(500).json({ error: 'could not send key' }); }
  res.json({ ok: true });
});

// Drop an image into a session: store the file, type its path into the Claude prompt via tmux.
// Works whether the session is open in a browser or in a native terminal, both attach to tmux.
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
app.post('/api/sessions/:id/image', express.raw({ type: 'image/*', limit: '25mb' }), (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  const ext = IMAGE_EXT[(req.headers['content-type'] || '').split(';')[0].trim()];
  if (!ext) return res.status(400).json({ error: 'only PNG, JPEG, GIF or WebP' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'empty upload' });
  const file = path.join(CONFIG.uploadDir, `${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}.${ext}`);
  try {
    // Private by default. In root mode 0755/0644, so the run-as user can read the file.
    fs.mkdirSync(CONFIG.uploadDir, { recursive: true, mode: isRoot ? 0o755 : 0o700 });
    // Refuse a folder another user planted or swapped for a symlink (e.g. in a shared /tmp).
    const st = fs.lstatSync(CONFIG.uploadDir);
    if (!st.isDirectory() || st.uid !== process.getuid()) throw new Error('upload dir not owned by sessiondeck');
    fs.writeFileSync(file, req.body, { mode: isRoot ? 0o644 : 0o600, flag: 'wx' });
    // -l = literal: the path lands in the prompt, you press Enter yourself.
    tmuxSync(['send-keys', '-t', s.id, '-l', file + ' ']);
  } catch (err) {
    console.error('image:', err.message);
    return res.status(500).json({ error: 'could not deliver image' });
  }
  res.json({ ok: true, path: file });
});

// Terminal proxy (HTTP and WebSocket) to the session's ttyd on localhost.
const proxy = httpProxy.createProxyServer({ ws: true });
proxy.on('error', (err, req, res) => {
  console.error('proxy:', err.message);
  if (res && res.writeHead && !res.headersSent) { res.writeHead(502); res.end('Session not reachable'); }
  else if (res && res.destroy) res.destroy();
});

function toTtyd(req, id) {
  const s = sessions[id];
  if (!s) return null;
  req.url = req.url.slice(`/terminal/${id}`.length) || '/';
  // Replace the browser's sessiondeck credentials with the per-session ttyd credential.
  req.headers.authorization = 'Basic ' + Buffer.from(`sessiondeck:${s.ttydAuth}`).toString('base64');
  return `http://127.0.0.1:${s.port}`;
}

app.use('/terminal/:id', (req, res) => {
  req.url = req.originalUrl;
  const target = toTtyd(req, req.params.id);
  if (!target) return res.status(404).send('Session not found');
  proxy.web(req, res, { target });
});

// UI. no-store for the page itself so a new version shows up right after an update.
const PUBLIC = path.join(__dirname, 'public');
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.sendFile(path.join(PUBLIC, 'index.html'));
});
app.use(express.static(PUBLIC, { index: false }));

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  const m = /^\/terminal\/([^/?]+)/.exec(req.url);
  if (!m || !authorized(req) || !sameOrigin(req.headers)) { socket.destroy(); return; }
  const target = toTtyd(req, m[1]);
  if (!target) { socket.destroy(); return; }
  proxy.ws(req, socket, head, { target });
});

// ── Startup ─────────────────────────────────────────────────────────
// Restore sessions whose tmux session still exists. A missing ttyd is started again.
// Without tmux (reboot, crash) a session stays only if its conversation is known; the peek
// round then revives it, ttyd included.
try {
  for (const s of JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))) {
    if (!isValidId(s.id) || !Number.isInteger(s.port) || !s.ttydAuth) continue;
    let alive = true;
    try { tmuxSync(['has-session', '-t', s.id]); } catch { alive = false; }
    if (!alive && !(s.status === 'running' && UUID_RE.test(s.claude || ''))) continue;
    sessions[s.id] = { ...s, status: 'running', process: null };
    if (alive) {
      if (!pidOnPort(s.port)) sessions[s.id].process = spawnTtyd(sessions[s.id]);
      labelTmuxSession(s.id, s.name, s.cwd);
    }
    if (s.port >= portCounter) portCounter = s.port + 1;
    console.log(`Recovered session ${s.id} (${s.name}) on port ${s.port}`);
  }
  saveSessions();
} catch { /* no file yet: fresh start */ }

cpuSample(); setTimeout(cpuSample, 2000); setInterval(cpuSample, 60000);
peekRound(); setInterval(peekRound, 4000);
setInterval(saveActivity, 60000);
setTimeout(runUpdates, 30000); setInterval(runUpdates, 30 * 60 * 1000);

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`sessiondeck listening on http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`projects root: ${CONFIG.root}`);
  if (!['127.0.0.1', '::1', 'localhost'].includes(CONFIG.host)) {
    console.warn('warning: bound to a non-loopback address. Put a reverse proxy with HTTPS in front, ' +
      'Basic auth over plain HTTP sends the password in clear text.');
  }
});
