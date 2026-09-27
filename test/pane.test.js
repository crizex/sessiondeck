const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { readPane } = require('../pane');

const RULE = '─'.repeat(20);

test('selection menu yields question and options', () => {
  const p = readPane(fs.readFileSync(__dirname + '/pane-question.txt', 'utf8'));
  assert.strictEqual(p.asking, true);
  assert.deepStrictEqual(p.question, {
    text: 'Which color should the button have?',
    options: [
      { nr: 1, text: 'Red (warm)', freeText: false },
      { nr: 2, text: 'Blue (cool)', freeText: false },
      { nr: 3, text: 'Green (fresh)', freeText: false },
      { nr: 4, text: 'Type something.', freeText: true },
      { nr: 5, text: 'Chat about this', freeText: false },
    ],
  });
});

test('pane without menu: no question, even with a numbered list in the text', () => {
  const p = readPane(`Plan:\n1. Test first\n2. Then build\n\n${RULE}\n❯ \n${RULE}\n  status\n`);
  assert.strictEqual(p.asking, false);
  assert.strictEqual(p.question, null);
});

test('trust dialog without numbers: asking, but no options', () => {
  const p = readPane('Do you trust the files in this folder?\n\n ❯ Yes, proceed\n   No, exit\n\n Enter to confirm · Esc to exit\n');
  assert.strictEqual(p.asking, true);
  assert.strictEqual(p.question, null);
});

test('context usage from the status line, null without a status line', () => {
  const p = readPane(`done\n${RULE}\n❯ \n${RULE}\n  ▓░░ 14% ctx (139k/1000k)\n  ⏵⏵ bypass permissions on\n`);
  assert.strictEqual(p.contextPct, 14);
  assert.strictEqual(p.tokensK, 139);
  assert.strictEqual(readPane('Today 42% ctx in the text\n').contextPct, null);
  assert.strictEqual(readPane('Today 42% ctx in the text\n').tokensK, null);
});

test('last artifact link in the pane, otherwise null', () => {
  const p = readPane('Here: https://claude.ai/artifact/abc-1\nand https://claude.ai/code/artifact/0f3e-9x\n');
  assert.strictEqual(p.artifact, 'https://claude.ai/code/artifact/0f3e-9x');
  assert.strictEqual(readPane('nothing\n').artifact, null);
});

test('spinner line counts as working', () => {
  const p = readPane(`Reading files\n✽ Ionizing\u2026 (1m 24s · ↓ 6.7k tokens)\n${RULE}\n❯ \n${RULE}\n`);
  assert.strictEqual(p.working, true);
});

test('background agents count as working', () => {
  const waiting = readPane(`I will report back once it is done.\n\n✻ Waiting for 1 background agent to finish\n\n${RULE}\n❯ \n${RULE}\n  17% ctx (173k/1000k)\n`);
  assert.strictEqual(waiting.working, true);
  const below = readPane(`Done.\n${RULE}\n❯ \n${RULE}\n  17% ctx (173k/1000k)\n❯ ● main\n  ○ general-purpose  Refactor parser      15m 45s · ↓ 185.7k tokens\n`);
  assert.strictEqual(below.working, true);
  const quiet = readPane(`Done.\n${RULE}\n❯ \n${RULE}\n  17% ctx (173k/1000k)\n`);
  assert.strictEqual(quiet.working, false);
});

test('running background shell counts as working', () => {
  const p = readPane(`I will be notified when it finishes.\n\n✻ Crunched for 9s · done 10:08 PM · 1 shell still running\n\n${RULE}\n❯ ok\n${RULE}\n  18% ctx (177k/1000k)\n  ⏵⏵ bypass permissions on · 1 shell · ← for agents\n`);
  assert.strictEqual(p.working, true);
  const onlyBelow = readPane(`Done.\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ bypass permissions on · 2 shells · ← for agents\n`);
  assert.strictEqual(onlyBelow.working, true);
});
