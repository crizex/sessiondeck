# Changelog

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
