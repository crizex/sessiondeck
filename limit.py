# Limit pause: stop working Claude Code sessions near the 5-hour limit and send them on after the reset.
# Usage comes from the status line (statusline.sh writes ~/.claude/sessiondeck-usage.json), so it costs no tokens.
# Shared by sessiondeck (limit.py) and SessionDeck Desktop (server/limit.py), both read the same state file.
#   status                       usage and paused sessions as JSON
#   pause <tmux>...              stop these sessions now (the caller passes the ones that are working)
#   resume                       send every paused session on
#   tick <percent> <tmux>...     once a minute: pause at <percent>, resume after the reset
import json, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

USAGE = os.path.expanduser('~/.claude/sessiondeck-usage.json')
STATE = os.path.expanduser('~/.claude/sessiondeck-limit.json')
GRACE = 60_000  # resume a minute after the reset, the server needs a moment
RESUME = ('The 5-hour limit has reset, the automatic limit pause is over. Continue exactly where you were interrupted. '
          'Resume stopped background agents first with SendMessage to their ID. If that fails, their transcript is in '
          '~/.claude/projects/<project>/<session id>/subagents/agent-<id>.jsonl: read its end and tell a new agent '
          'what is already done instead of starting over.')


def read(path):
    try:
        with open(path) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def write(path, d):
    tmp = f'{path}.{os.getpid()}'
    with open(tmp, 'w') as f:
        json.dump(d, f)
    os.replace(tmp, path)


def window(d, now):
    """(percent, reset in ms) of one limit window. A window whose reset has passed counts as 0 %:
    the status line only writes while a session runs, so the file can be older than the reset."""
    pct, reset = (d or {}).get('used_percentage'), (d or {}).get('resets_at')
    reset = int(reset) * 1000 if isinstance(reset, (int, float)) else None
    if pct is None:
        return None, reset
    return (0 if reset and now >= reset else round(pct)), reset


def usage(now):
    u = read(USAGE)
    pct, reset = window(u.get('five_hour'), now)
    week, week_reset = window(u.get('seven_day'), now)
    return {'pct': pct, 'reset': reset, 'week': week, 'weekReset': week_reset}


def tmux(*a):
    subprocess.run(['tmux', *a], timeout=10, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def stop(t):
    """Escape stops the main turn, Ctrl+X Ctrl+K (twice, to confirm) the background agents. Their "agent stopped"
    note wakes the main turn again, so two more Escapes with a gap (close together they open the rewind menu)."""
    tmux('send-keys', '-t', t, 'Escape')
    time.sleep(1)
    for _ in range(2):
        tmux('send-keys', '-t', t, 'C-x', 'C-k')
        time.sleep(0.4)
    for _ in range(2):
        time.sleep(4)
        tmux('send-keys', '-t', t, 'Escape')


def send_on(names):
    for t in names:
        tmux('send-keys', '-t', t, '-l', RESUME)
        time.sleep(0.3)
        tmux('send-keys', '-t', t, 'Enter')


def pause(names, st, reset, now):
    with ThreadPoolExecutor(8) as p:  # in parallel, each stop takes about 10 s
        list(p.map(stop, names))
    paused = list(dict.fromkeys(st.get('paused', []) + names))
    return {'paused': paused, 'until': max(st.get('until', 0), (reset or now + 5 * 3600_000) + GRACE)}


def tick(limit, names, st, u, now):
    """One round of the automatic pause; returns (new state, what to do). Only one pause per limit window:
    whoever starts after it may use the rest."""
    if 'until' in st:
        if now < st['until'] or (u['pct'] or 0) >= limit:
            return st, None
        return {}, 'resume'
    if u['pct'] is not None and u['pct'] >= limit and names:
        return st, 'pause'
    return st, None


def main(argv):
    os.environ.pop('TMUX', None)  # never reach into another tmux server
    mode, now = (argv[1] if len(argv) > 1 else 'status'), int(time.time() * 1000)
    st, u = read(STATE), usage(now)
    if mode == 'status':
        print(json.dumps({**u, 'paused': st.get('paused', []), 'until': st.get('until')}))
    elif mode == 'pause':
        names = argv[2:]
        write(STATE, pause(names, st, u['reset'], now))
        print(len(names))
    elif mode == 'resume':
        send_on(st.get('paused', []))
        write(STATE, {'paused': [], 'until': st.get('until', now)})  # "until" stays: no new pause in this window
        print(len(st.get('paused', [])))
    elif mode == 'tick':
        new, do = tick(int(argv[2]), argv[3:], st, u, now)
        if do == 'resume':
            send_on(st.get('paused', []))
            write(STATE, new)
        elif do == 'pause':
            write(STATE, pause(argv[3:], st, u['reset'], now))
        print(do or '')
    else:
        sys.exit(f'unknown mode {mode}')


if __name__ == '__main__':
    main(sys.argv)
