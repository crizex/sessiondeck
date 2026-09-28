# Changelog

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
