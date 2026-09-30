// Revive after a crash: when the tmux server dies (kill-server, reboot, user manager stopped),
// every Claude session is gone while its conversation is still on disk. sessiondeck remembers
// the conversation id and the start time of the tmux server for each session. If a session is
// missing and a different (or no) tmux server is running now, it crashed. If it is missing while
// the server is unchanged, you ended it yourself (/exit), and it stays off.
// ponytail: if only a single pane dies (OOM), the server stays the same and nothing happens.
const { UUID_RE } = require('./guard');

function shouldRevive(s, serverStart) {
  return s.status === 'running' && UUID_RE.test(s.claude || '') &&
    !!s.tmuxStart && s.tmuxStart !== serverStart;
}

// ~/.claude/sessions/<pid>.json -> { tmux session: conversation id }. A pane can have several
// entries (plugin observers, SDK subprocesses); the main process has entrypoint "cli".
function conversationsFromPidFiles(entries) {
  const m = {};
  for (const d of entries) {
    if (d?.entrypoint === 'cli' && typeof d.tmux === 'string' && UUID_RE.test(d.sessionId || '')) {
      m[d.tmux.split(':')[0]] = d.sessionId;
    }
  }
  return m;
}

const NUDGE = 'This session crashed (the tmux server was gone) and sessiondeck restored it ' +
  'automatically. Running commands, background jobs and subagents were cancelled on the way. ' +
  'Check briefly what is actually done, then continue exactly where you left off.';

module.exports = { shouldRevive, conversationsFromPidFiles, NUDGE };
