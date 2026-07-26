#!/usr/bin/env node
/* reviewloop installer — wires the bridge into Codex and Claude in one command.
   Usage:
     node install.js                 install into detected configs
     node install.js --codex-config <path-to-config.toml>
     node install.js --sessions-dir <path-to-codex-sessions>
     node install.js --uninstall
   Zero dependencies. Node >= 18. */

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const SHIM = path.join(__dirname, 'shim.js');
const HOME = process.env.REVIEWLOOP_HOME || path.join(os.homedir(), '.reviewloop');
const MARK_START = '# >>> reviewloop >>>';
const MARK_END = '# <<< reviewloop <<<';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] || true) : null; };
const UNINSTALL = args.includes('--uninstall');

function log(s) { console.log(s); }
function stamp() { return new Date().toISOString().slice(0, 10).replace(/-/g, ''); }

function codexBlock() {
  return `${MARK_START}
[mcp_servers.reviewloop]
command = 'node'
args = ['${SHIM.replace(/'/g, "''")}']
tool_timeout_sec = 180
${MARK_END}
`;
}

function codexCandidates() {
  const c = [];
  const explicit = flag('--codex-config');
  if (explicit) c.push(explicit);
  if (process.env.CODEX_HOME) c.push(path.join(process.env.CODEX_HOME, 'config.toml'));
  c.push(path.join(os.homedir(), '.codex', 'config.toml'));
  return [...new Set(c)].filter(p => fs.existsSync(p));
}

function installCodex() {
  const found = codexCandidates();
  if (!found.length) {
    log('! No Codex config.toml found (checked --codex-config, $CODEX_HOME, ~/.codex).');
    log('  Add this block to your Codex config.toml manually:\n');
    log(codexBlock());
    return;
  }
  for (const cfg of found) {
    const content = fs.readFileSync(cfg, 'utf8');
    if (content.includes('mcp_servers.reviewloop')) { log(`= Codex: already installed in ${cfg}`); continue; }
    fs.copyFileSync(cfg, `${cfg}.bak.reviewloop-${stamp()}`);
    fs.appendFileSync(cfg, '\n' + codexBlock());
    log(`+ Codex: installed in ${cfg} (backup written). Restart Codex to load it.`);
  }
}

function uninstallCodex() {
  for (const cfg of codexCandidates()) {
    const content = fs.readFileSync(cfg, 'utf8');
    const re = new RegExp(`\\n?${MARK_START}[\\s\\S]*?${MARK_END}\\n?`, 'g');
    if (re.test(content)) {
      fs.copyFileSync(cfg, `${cfg}.bak.reviewloop-uninstall-${stamp()}`);
      fs.writeFileSync(cfg, content.replace(re, '\n'));
      log(`- Codex: removed from ${cfg}`);
    } else if (content.includes('mcp_servers.reviewloop')) {
      log(`! Codex: found an unmarked reviewloop block in ${cfg} — remove it manually.`);
    }
  }
}

function claudeCli(cmdArgs) {
  const r = spawnSync(process.platform === 'win32' ? 'claude.cmd' : 'claude', cmdArgs, { encoding: 'utf8', shell: process.platform === 'win32' });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

function installClaude() {
  const out = claudeCli(['mcp', 'add', '--scope', 'user', 'reviewloop', '--', 'node', SHIM]);
  if (out !== null) { log('+ Claude: registered via `claude mcp add --scope user reviewloop`.'); return; }
  log('! Claude CLI not found or add failed. Register manually — Claude Code:');
  log(`    claude mcp add --scope user reviewloop -- node "${SHIM}"`);
  log('  Or add to .mcp.json:');
  log(JSON.stringify({ mcpServers: { reviewloop: { type: 'stdio', command: 'node', args: [SHIM] } } }, null, 2));
}

function uninstallClaude() {
  if (claudeCli(['mcp', 'remove', '--scope', 'user', 'reviewloop']) !== null) log('- Claude: removed.');
  else log('! Claude: remove manually with `claude mcp remove reviewloop` (or delete from .mcp.json).');
}

function installSessionsDir() {
  const explicit = flag('--sessions-dir');
  const candidates = [
    explicit,
    process.env.CODEX_HOME && path.join(process.env.CODEX_HOME, 'sessions'),
    path.join(os.homedir(), '.codex', 'sessions')
  ].filter(Boolean).filter(p => fs.existsSync(p));
  fs.mkdirSync(HOME, { recursive: true });
  const cfgPath = path.join(HOME, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  if (candidates.length && !cfg.codex_sessions_dir) {
    cfg.codex_sessions_dir = candidates[0];
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    log(`+ Heartbeat: codex_sessions_dir = ${candidates[0]}`);
  } else if (cfg.codex_sessions_dir) {
    log(`= Heartbeat: codex_sessions_dir already set (${cfg.codex_sessions_dir})`);
  } else {
    log('! Heartbeat: no Codex sessions dir found — set it later in ' + cfgPath + ' (desktop-app users: point it at your app home\'s sessions folder).');
  }
}

function selftest() {
  log('\nRunning selftest...');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'shim.js'), '--selftest'], { encoding: 'utf8' });
  const lines = (r.stdout || '').trim().split('\n');
  log('  ' + (lines.find(l => l.startsWith('PASS')) || lines.slice(-1)[0] || 'no output'));
  if (r.status !== 0) { log('SELFTEST FAILED:\n' + r.stdout + r.stderr); process.exit(1); }
}

if (UNINSTALL) {
  uninstallCodex();
  uninstallClaude();
  log('\nUninstalled. State in ' + HOME + ' was kept; delete it manually if wanted.');
} else {
  log('reviewloop installer\n');
  installCodex();
  installClaude();
  installSessionsDir();
  selftest();
  log(`\nDone. Next steps:
  1. Restart Codex (and Claude Code if running) to load the server.
  2. In any session with the tools: call loop_setup with your Codex thread id and Claude thread id
     (optional: repo, reviewer_paths, stop {max_directives, max_minutes}).
  3. Paste worker_prompt into the Codex thread, reviewer_prompt into the Claude thread.
  4. Both sides report PAIRING CONFIRMED — then give the task in the Claude thread (with model + effort).
  Stop: your stop policy, a context_warning from either side, the reviewer's done:true, or you.`);
}
