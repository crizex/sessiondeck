// Small, pure security helpers. Kept separate from server.js so they can be tested without
// starting tmux, ttyd or an HTTP listener.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Session ids are generated server side (base36). Anything else is rejected before it can
// reach a tmux or ttyd argument.
const ID_RE = /^[a-zA-Z0-9]{1,64}$/;
function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

// Claude Code conversation ids, the only accepted value for --resume.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Resolves a requested working directory and makes sure it stays inside root, following
// symlinks, so a link inside the projects folder cannot point a session at /etc or ~/.ssh.
function resolveWorkdir(root, cwd) {
  const realRoot = fs.realpathSync(root);
  let resolved;
  try {
    resolved = fs.realpathSync(path.resolve(realRoot, cwd || '.'));
  } catch {
    throw new Error('working directory does not exist');
  }
  if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
    throw new Error('working directory must be inside the projects root');
  }
  if (!fs.statSync(resolved).isDirectory()) throw new Error('working directory is not a folder');
  return resolved;
}

// Constant-time comparison of an HTTP Basic Authorization header against the configured
// credentials. Hashing first makes both buffers the same length.
function checkBasicAuth(header, user, password) {
  const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header || '');
  if (!m) return false;
  const given = Buffer.from(m[1], 'base64').toString('utf8');
  const h = s => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(given), h(`${user}:${password}`));
}

// Browsers attach cached Basic credentials to cross-site requests. State-changing requests
// and WebSocket upgrades therefore must come from our own origin.
function sameOrigin(headers) {
  const origin = headers.origin;
  if (!origin) return true; // non-browser clients (curl, scripts) send no Origin
  try { return new URL(origin).host === headers.host; } catch { return false; }
}

module.exports = { isValidId, UUID_RE, resolveWorkdir, checkBasicAuth, sameOrigin };
