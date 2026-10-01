// Reads the visible tmux pane of a Claude Code session: last lines, is it working,
// is it asking something.

const ELLIPSIS = '\u2026';

// While working, Claude Code shows a spinner line like "* Ionizing<ellipsis> (1m 24s . 6.7k tokens)".
const WORKING_RE = new RegExp(`${ELLIPSIS}\\s*\\((?:\\d+h\\s*)?(?:\\d+m\\s*)?\\d+s\\b`);
// Claude is done but waits for subagents ("Waiting for 1 background agent", one line per agent
// with a running clock) or a background shell is still running. Needs no attention, so it
// counts as working.
// ponytail: a long-running dev server keeps the session in "working" as well.
const BACKGROUND_RE = /Waiting for \d+ background|\d+s · [↓↑] [\d.]+k? tokens|\d+ shells? still running|· \d+ shells? ·/;
// Selection menu (AskUserQuestion, permission prompt, trust dialog): Claude waits for a decision.
const QUESTION_RE = /Enter to select|Enter to confirm|Do you want to|Would you like to|❯\s*1\./;
const OPTION_RE = /^\s*(?:❯\s*)?(\d+)\.\s+(.+)$/;

// Menu read from the bottom: the last "1." and every following number in sequence.
// The question is the line before it.
function readMenu(lines) {
  const start = lines.findLastIndex(l => OPTION_RE.exec(l)?.[1] === '1');
  if (start < 0) return null;
  const options = [];
  for (const l of lines.slice(start)) {
    const m = OPTION_RE.exec(l);
    if (m && +m[1] === options.length + 1) {
      const text = m[2].trim();
      options.push({ nr: +m[1], text, freeText: /^Type something\.?$/.test(text) });
    }
  }
  const text = lines.slice(0, start).findLast(l => l.trim() && !/^\s*☐/.test(l) && !/^─{10,}/.test(l));
  // Inside a box the line starts and ends with a frame bar: not part of the question.
  return { text: (text || '').replace(/^\s*[│|]\s*|\s*[│|]\s*$/g, '').trim(), options };
}

function readPane(raw) {
  const lines = raw.replace(/\s+$/, '').split('\n').map(l => l.replace(/\s+$/, ''));
  // The input box sits between the last two horizontal rules, the status lines below it.
  const rules = lines.map((l, i) => (/^─{10,}/.test(l) ? i : -1)).filter(i => i >= 0);
  const end = rules.length >= 2 ? rules[rules.length - 2] : lines.length;
  const content = lines.slice(0, end).filter(l => l.trim() && !/^\s*⎿\s+Tip:/.test(l));
  const bottom = lines.slice(-25);
  const asking = QUESTION_RE.test(bottom.join('\n'));
  const status = rules.length >= 2 ? lines.slice(end).join('\n') : '';
  const context = /(\d+)% ctx\b/.exec(status);
  const tokens = /\bctx \((\d+)k\//.exec(status);
  const artifacts = raw.match(/https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/g);
  return {
    lines: content.slice(-7).map(l => l.slice(0, 200)),
    working: content.slice(-4).some(l => WORKING_RE.test(l) || BACKGROUND_RE.test(l)) || BACKGROUND_RE.test(status),
    asking,
    question: asking ? readMenu(bottom) : null,
    // Status line below the input box, for example "14% ctx (139k/1000k)"
    contextPct: context ? Number(context[1]) : null,
    // Tokens used, in thousands.
    tokensK: tokens ? Number(tokens[1]) : null,
    artifact: artifacts ? artifacts[artifacts.length - 1] : null,
  };
}

module.exports = { readPane };
