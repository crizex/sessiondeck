#!/bin/sh
# Claude Code status line, e.g. "Opus | 42% ctx (84k/200k)" (the context bar of SessionDeck Desktop reads it).
# It also keeps the 5-hour and weekly usage in ~/.claude/sessiondeck-usage.json for the limit display and
# the limit pause (Claude.ai subscriptions only, no extra API calls).
# Install on the server:
#   cp statusline.sh ~/.claude/statusline.sh && chmod +x ~/.claude/statusline.sh
# and in ~/.claude/settings.json:
#   "statusLine": { "type": "command", "command": "~/.claude/statusline.sh" }
# Needs jq. To keep your own status line, add the line that writes sessiondeck-usage.json to it.
input=$(cat)
usage="$HOME/.claude/sessiondeck-usage.json"
{ printf '%s' "$input" | jq -ce '.rate_limits | select(.five_hour)' > "$usage.$$" && mv "$usage.$$" "$usage" || rm -f "$usage.$$"; } 2>/dev/null
printf '%s' "$input" | jq -r '
  .context_window as $c
  | (.model.display_name // "") as $m
  | if ($c.context_window_size // 0) > 0 then
      "\($m) | \(($c.used_percentage // 0) | floor)% ctx (\((($c.total_input_tokens // 0) / 1000) | floor)k/\(($c.context_window_size / 1000) | floor)k)"
    else $m end'
