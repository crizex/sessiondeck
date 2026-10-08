# Changelog

## 1.2.2

**Fix**
- Long questions from AskUserQuestion now arrive in full. The terminal wraps a long question over several lines,
  and only the last line ended up on the card (for example just "are online?").

## 1.2.1

**Fix**
- Server panel: "terminals together" now counts the memory of everything running inside the sessions (Claude Code,
  Node, builds below the tmux server) plus ttyd. Before it only counted ttyd itself and showed about 0.0 GB.

## 1.2.0

**5-hour limit**
- New side panel "5-hour limit": how much is used, when it resets and the weekly share. Hidden until the numbers
  exist.
- The numbers come from Claude Code's status line. The new `statusline.sh` writes them to
  `~/.claude/sessiondeck-usage.json`; no extra API calls, no tokens.

**Limit pause**
- `SESSIONDECK_LIMIT_PAUSE=90` (off by default): at that percent every working session stops (Escape, background
  agents included), and after the reset each one gets a note to continue where it was. Once per limit window.
- Command palette: "Pause all working sessions now" and "Send paused sessions on", plus a button in the panel
  while sessions are paused. New API `GET /api/limit`, `POST /api/limit/pause` and `/api/limit/resume`, behind the
  login and the same-origin check like every other write.
- In root mode it runs as `SESSIONDECK_RUN_AS`, with a minimal environment.

**Fix**
- Question cards: a question inside a box no longer starts with the frame bar (`│ Did it work?`).

## 1.1.0

**Crash recovery**
- sessiondeck now remembers each session's Claude conversation and the start time of the tmux server.
- When the tmux server dies (crash, reboot, `tmux kill-server`), the lost sessions start again by
  themselves with `claude --resume` in the same folder, terminal included. Also right after a reboot,
  when sessiondeck starts before any tmux server exists.
- A session that was working when it crashed gets a short note to check what is really done and continue.
- Sessions you ended yourself with `/exit` stay off.

**Updates**
- New side panel "Updates": shows when Claude Code or an enabled plugin has a newer version.
  Checked every 30 minutes, or right away with "Check for updates now" in the command palette.
- "Install N updates" (panel or palette) runs `claude update` and `claude plugin update`,
  checks again and lists what worked.
- In root mode the check runs as `SESSIONDECK_RUN_AS`, with a minimal environment.

**Security**
- The login password is removed from the environment at startup. Before, the tmux server and with it
  every Claude session inherited `SESSIONDECK_PASSWORD`.

## 1.0.2

- README: the diagram is readable on GitHub again, labels no longer get cut off inside their boxes.

## 1.0.1

- README: short demo animation of a question card being answered from the deck.

## 1.0.0

First public release.

- Start Claude Code sessions in any project folder, each in its own tmux session.
- Live session cards with the last terminal lines, state (working, waiting for you, idle),
  context usage and a 24 hour activity strip.
- Question cards: answer Claude's choices and permission prompts with one tap, straight from the card.
- Image drop: drag or paste a screenshot onto a card and its path is typed into the Claude prompt.
- Full terminal in the browser through ttyd, with tmux attach from SSH still possible.
- Sessions survive browser disconnects and restarts of sessiondeck.
- Server panel with CPU history, memory, disk and terminal RAM.
- Command palette (Cmd/Ctrl+K), keyboard shortcut `N` for a new session, press and hold to end a session.
- Works on phones and tablets.
- Secure by default: required password, localhost binding, per-session ttyd credentials,
  CSRF and cross-site WebSocket protection, working directories confined to the projects root.
- Configuration through environment variables, example systemd unit included.
