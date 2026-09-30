const test = require('node:test');
const assert = require('node:assert');
const { shouldRevive, conversationsFromPidFiles } = require('../revive');

const UUID = '0771b0ba-14af-40cf-855b-c35ed59eb778';
const s = extra => ({ status: 'running', claude: UUID, tmuxStart: '100', ...extra });

test('tmux server restarted: session is revived', () => {
  assert.strictEqual(shouldRevive(s(), '200'), true);
});

test('no tmux server at all (reboot): session is revived', () => {
  assert.strictEqual(shouldRevive(s(), null), true);
});

test('same server, session missing: ended by the user, stays off', () => {
  assert.strictEqual(shouldRevive(s(), '100'), false);
});

test('no revive without conversation id, start time, running status or with a bad id', () => {
  assert.strictEqual(shouldRevive(s({ claude: undefined }), '200'), false);
  assert.strictEqual(shouldRevive(s({ claude: 'x; rm -rf /' }), '200'), false);
  assert.strictEqual(shouldRevive(s({ tmuxStart: null }), '200'), false);
  assert.strictEqual(shouldRevive(s({ status: 'stopped' }), '200'), false);
});

test('pid files: only the main cli process per tmux session counts', () => {
  const m = conversationsFromPidFiles([
    { tmux: 'mujysawk849:@1.%1', sessionId: UUID, entrypoint: 'cli' },
    { tmux: 'mujysawk849:@1.%1', sessionId: 'f7d2980c-0375-4706-a7b2-6658a99545a5', entrypoint: 'sdk-cli' },
    { sessionId: 'dcf80487-7f16-4d6f-8f2e-02e97bd47b00', entrypoint: 'cli' },
    null,
  ]);
  assert.deepStrictEqual(m, { mujysawk849: UUID });
});
