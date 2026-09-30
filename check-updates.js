#!/usr/bin/env node
// Checks Claude Code and the installed, enabled plugins for updates and prints the result as JSON.
//   node check-updates.js          -> check only
//   node check-updates.js --apply  -> install everything outdated, then check again
// sessiondeck runs this as the user that runs Claude Code and stores the output.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE = process.env.SESSIONDECK_CLAUDE_BIN || 'claude';
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PLUGDIR = path.join(CONFIG_DIR, 'plugins');

// Arguments as an array, never through a shell. null on any failure.
const run = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { return null; }
};
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const isSha = v => !!v && /^[0-9a-f]{12,40}$/.test(v);
// Commits cut to 12 characters so installed and remote spelling compare equal.
const short = v => (isSha(v) ? v.slice(0, 12) : v || null);
const gitShow = (dir, file) => run('git', ['-C', dir, 'show', `origin/HEAD:${file}`]);

function latestPlugin(name, mp, loc) {
  if (fs.existsSync(path.join(loc, '.git'))) {
    run('git', ['-C', loc, 'fetch', '-q', 'origin']);
    const mkt = gitShow(loc, '.claude-plugin/marketplace.json');
    let v = null;
    try { v = (JSON.parse(mkt).plugins || []).find(p => p.name === name)?.version || null; } catch {}
    // Single-plugin repos keep the version only in plugin.json.
    if (!v) { try { v = JSON.parse(gitShow(loc, '.claude-plugin/plugin.json')).version || null; } catch {} }
    return v;
  }
  // Marketplaces that are not a git checkout: let Claude refresh its copy, then read it.
  run(CLAUDE, ['plugin', 'marketplace', 'update', mp]);
  const entry = (readJson(path.join(loc, '.claude-plugin/marketplace.json'))?.plugins || []).find(p => p.name === name);
  const gcs = path.join(loc, '.gcs-sha');
  return entry?.version || entry?.source?.sha || (fs.existsSync(gcs) ? fs.readFileSync(gcs, 'utf8').trim() : null);
}

function check() {
  const items = [{
    id: 'cli', name: 'Claude Code',
    current: (run(CLAUDE, ['--version']) || '').split(' ')[0] || null,
    latest: run('npm', ['view', '@anthropic-ai/claude-code', 'version']),
  }];
  const installed = readJson(path.join(PLUGDIR, 'installed_plugins.json'))?.plugins || {};
  const markets = readJson(path.join(PLUGDIR, 'known_marketplaces.json')) || {};
  const enabled = readJson(path.join(CONFIG_DIR, 'settings.json'))?.enabledPlugins || {};

  for (const [key, entries] of Object.entries(installed)) {
    if (enabled[key] === false || !Array.isArray(entries) || !entries.length) continue;
    const [name, mp] = key.split('@');
    const loc = markets[mp]?.installLocation;
    const latest = loc ? latestPlugin(name, mp, loc) : null;
    // If latest is a commit, compare against the installed commit, not the version.
    const raw = isSha(latest) ? entries[0].gitCommitSha || entries[0].version : entries[0].version;
    items.push({ id: key, name, current: short(!raw || raw === 'unknown' ? null : raw), latest: short(latest) });
  }
  return {
    checkedAt: Date.now(),
    items: items.map(i => ({ ...i, outdated: !!(i.latest && i.current && i.latest !== i.current) })),
  };
}

function apply(state) {
  const log = [];
  for (const item of state.items.filter(i => i.outdated)) {
    let ok;
    if (item.id === 'cli') {
      ok = run(CLAUDE, ['update']);
    } else {
      run(CLAUDE, ['plugin', 'marketplace', 'update', item.id.split('@')[1]]);
      ok = run(CLAUDE, ['plugin', 'update', item.id]);
    }
    log.push(`${item.name} ${item.current} -> ${item.latest}: ${ok === null ? 'failed' : 'ok'}`);
  }
  return log;
}

let state = check();
if (process.argv.includes('--apply')) {
  const log = apply(state);
  state = { ...check(), log };
}
process.stdout.write(JSON.stringify(state));
