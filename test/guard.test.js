const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isValidId, UUID_RE, resolveWorkdir, checkBasicAuth, sameOrigin } = require('../guard');

test('session ids: only short alphanumeric strings', () => {
  assert.ok(isValidId('mf3k2abc'));
  for (const bad of ['', 'a b', 'a;rm', '../x', 'x'.repeat(65), 42, null]) assert.ok(!isValidId(bad), String(bad));
});

test('resume only accepts a conversation uuid', () => {
  assert.ok(UUID_RE.test('0f3e1a2b-1234-4abc-9def-0123456789ab'));
  assert.ok(!UUID_RE.test('0f3e1a2b-1234-4abc-9def-0123456789ab; rm -rf /'));
});

test('working directory stays inside the root, also through symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-root-'));
  fs.mkdirSync(path.join(root, 'app'));
  fs.symlinkSync(os.tmpdir(), path.join(root, 'escape'));
  const real = fs.realpathSync(root);
  assert.strictEqual(resolveWorkdir(root, 'app'), path.join(real, 'app'));
  assert.strictEqual(resolveWorkdir(root, ''), real);
  assert.throws(() => resolveWorkdir(root, '..'), /inside/);
  assert.throws(() => resolveWorkdir(root, '/etc'), /inside/);
  assert.throws(() => resolveWorkdir(root, 'escape'), /inside/);
  assert.throws(() => resolveWorkdir(root, 'missing'), /does not exist/);
  fs.rmSync(root, { recursive: true });
});

test('basic auth accepts exactly the configured credentials', () => {
  const hdr = s => 'Basic ' + Buffer.from(s).toString('base64');
  assert.ok(checkBasicAuth(hdr('admin:correct horse'), 'admin', 'correct horse'));
  assert.ok(!checkBasicAuth(hdr('admin:wrong'), 'admin', 'correct horse'));
  assert.ok(!checkBasicAuth(hdr('other:correct horse'), 'admin', 'correct horse'));
  assert.ok(!checkBasicAuth(undefined, 'admin', 'correct horse'));
  assert.ok(!checkBasicAuth('Bearer x', 'admin', 'correct horse'));
});

test('same origin check for browser requests', () => {
  assert.ok(sameOrigin({ host: 'deck.example.com' }));
  assert.ok(sameOrigin({ host: 'deck.example.com', origin: 'https://deck.example.com' }));
  assert.ok(!sameOrigin({ host: 'deck.example.com', origin: 'https://evil.example' }));
  assert.ok(!sameOrigin({ host: 'deck.example.com', origin: 'null' }));
});
