#!/usr/bin/env node
/* reviewloop shim — stdio MCP server. Register this same file in BOTH
   Codex (config.toml [mcp_servers.reviewloop]) and Claude (mcp config).
   It speaks newline-delimited JSON-RPC on stdio, forwards every tool call
   to the local daemon over HTTP, and auto-spawns the daemon if absent.
   Zero dependencies. Node >= 18.

   Also: `node shim.js --selftest` runs the full pairing + message flow
   end to end with no AI involved, and prints PASS/FAIL. */

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const HOME = process.env.REVIEWLOOP_HOME || path.join(os.homedir(), '.reviewloop');
const PORTFILE = path.join(HOME, 'daemon.json');
const DAEMON = path.join(__dirname, 'daemon.js');
const VERSION = '0.1.0';

/* ---------------- daemon client ---------------- */

function readPortfile() {
  try { return JSON.parse(fs.readFileSync(PORTFILE, 'utf8')); } catch { return null; }
}

function httpJson(pf, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, params });
    const req = http.request({
      host: '127.0.0.1', port: pf.port, path: '/rpc', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': pf.token, 'content-length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const obj = JSON.parse(data || '{}');
          if (res.statusCode >= 400) reject(new Error(obj.error || `daemon ${res.statusCode}`));
          else resolve(obj);
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs || 175_000, () => req.destroy(new Error('daemon request timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

function health(pf) {
  return new Promise((resolve) => {
    if (!pf) return resolve(false);
    const req = http.request({ host: '127.0.0.1', port: pf.port, path: '/health', method: 'GET' }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).app === 'reviewloop'); } catch { resolve(false); } });
    });
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function ensureDaemon() {
  let pf = readPortfile();
  if (await health(pf)) return pf;
  fs.mkdirSync(HOME, { recursive: true });
  const child = spawn(process.execPath, [DAEMON], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    pf = readPortfile();
    if (await health(pf)) return pf;
  }
  throw new Error(`Could not start reviewloop daemon (looked for ${PORTFILE}). Try: node "${DAEMON}"`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function daemonCall(method, params, timeoutMs) {
  const pf = await ensureDaemon();
  return httpJson(pf, method, params, timeoutMs);
}

/* ---------------- MCP tool definitions ---------------- */

const S = (props, required) => ({ type: 'object', properties: props, required: required || [] });
const str = d => ({ type: 'string', description: d });
const num = d => ({ type: 'number', description: d });
const obj = d => ({ type: 'object', description: d, additionalProperties: true });

const TOOLS = [
  {
    name: 'loop_register',
    description: 'Opt this session into the review loop. Call once, at the start, before anything runs. role: "worker" (Codex — does the work) or "reviewer" (Claude — reviews and instructs). Returns a pairing key to show the human.',
    inputSchema: S({ role: str('"worker" or "reviewer"'), label: str('short run name shared by both sides, e.g. "p04"') }, ['role', 'label'])
  },
  {
    name: 'loop_link',
    description: 'Link one worker key and one reviewer key into an active pair. Usually invoked once, on human instruction. Optional repo path enables git-based checks (get_checks).',
    inputSchema: S({ key_a: str('first key'), key_b: str('second key'), repo: str('optional absolute path to the git repo the worker operates on') }, ['key_a', 'key_b'])
  },
  {
    name: 'loop_status',
    description: 'Status. With a key: that pair’s state and open tickets. Without: all unlinked keys, active pairs, and suggested links.',
    inputSchema: S({ key: str('optional — your pairing key') })
  },
  {
    name: 'loop_unlink',
    description: 'End the active pair for this key. Both keys survive and can be re-linked (reviewer succession: new reviewer registers, re-link with the surviving worker key).',
    inputSchema: S({ key: str('your pairing key') }, ['key'])
  },
  {
    name: 'submit_for_review',
    description: 'WORKER. Submit a completed unit of work for review and stop working. handoff is a JSON object; recommended fields: summary, stop_reason (completed | blocked_needs_ruling | precondition_failed | aborted), changed_files[], commands_run[], tests{}, blockers[], questions[], confidence. Returns a ticket immediately; then call await_ruling.',
    inputSchema: S({ key: str('worker pairing key'), handoff: obj('the structured handoff') }, ['key', 'handoff'])
  },
  {
    name: 'await_ruling',
    description: 'WORKER. Block (bounded) until the reviewer rules on a ticket. Returns status:"pending" on timeout — call again with the same ticket until you receive the ruling. Do not start new work while pending.',
    inputSchema: S({ key: str('worker pairing key'), ticket: str('ticket id from submit_for_review'), timeout_ms: num('max wait, default 25000, hard cap 110000') }, ['key', 'ticket'])
  },
  {
    name: 'get_standing_rules',
    description: 'Read the durable standing rules for this loop. The worker should read these before starting any directive.',
    inputSchema: S({ key: str('your pairing key') }, ['key'])
  },
  {
    name: 'await_work',
    description: 'REVIEWER. Block (bounded) until the worker submits. Returns status:"pending" on timeout — call again. When it returns work, review the handoff (and get_checks), draft a ruling, get the human’s approval in this conversation, then submit_ruling.',
    inputSchema: S({ key: str('reviewer pairing key'), timeout_ms: num('max wait, default 25000, hard cap 110000') }, ['key'])
  },
  {
    name: 'submit_ruling',
    description: 'REVIEWER. Deliver the ruling for a ticket after the human approves it. ruling: { verdict: approve|revise|rule|abort, relay: exact text handed to the worker verbatim, stop_when, expected, do_not[], standing_rule?, done }. done:true together with verdict:approve ends the run.',
    inputSchema: S({ key: str('reviewer pairing key'), ticket: str('ticket id'), ruling: obj('the ruling object') }, ['key', 'ticket', 'ruling'])
  },
  {
    name: 'get_checks',
    description: 'Mechanical verification of a ticket against the repo attached at loop_link: git diff vs handoff.changed_files (report vs reality), plus untracked files. Fails closed: returns could_not_verify rather than pretending to pass.',
    inputSchema: S({ key: str('your pairing key'), ticket: str('ticket id') }, ['key', 'ticket'])
  }
];

/* ---------------- stdio JSON-RPC ---------------- */

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

function result(id, res) { send({ jsonrpc: '2.0', id, result: res }); }
function rpcError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return result(id, {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'reviewloop', version: VERSION }
    });
  }
  if (method === 'notifications/initialized' || (method && method.startsWith('notifications/'))) return;
  if (method === 'ping') return result(id, {});
  if (method === 'tools/list') return result(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) return rpcError(id, -32602, `Unknown tool ${name}`);
    /* keepalive: emit progress during long waits if the client sent a token */
    const token = params && params._meta && params._meta.progressToken;
    let tick = 0, prog = null;
    if (token !== undefined && (name === 'await_ruling' || name === 'await_work')) {
      prog = setInterval(() => send({
        jsonrpc: '2.0', method: 'notifications/progress',
        params: { progressToken: token, progress: ++tick, message: 'waiting' }
      }), 5000);
    }
    try {
      const res = await daemonCall(name, args);
      return result(id, { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] });
    } catch (e) {
      return result(id, { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] });
    } finally { if (prog) clearInterval(prog); }
  }
  if (id !== undefined) rpcError(id, -32601, `Method not found: ${method}`);
}

function serveStdio() {
  let buf = '';
  let pending = 0;
  let ended = false;
  const maybeExit = () => { if (ended && pending === 0) process.exit(0); };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      pending++;
      handle(msg)
        .catch(e => { if (msg.id !== undefined) rpcError(msg.id, -32603, e.message); })
        .finally(() => { pending--; maybeExit(); });
    }
  });
  process.stdin.on('end', () => {
    ended = true;
    setTimeout(() => process.exit(0), 120_000).unref();
    maybeExit();
  });
}

/* ---------------- selftest ---------------- */

async function selftest() {
  const out = [];
  const say = s => { out.push(s); console.log(s); };
  try {
    say('1. daemon up');
    await ensureDaemon();

    say('2. register worker + reviewer (label selftest-' + Date.now() + ')');
    const label = 'selftest-' + Date.now();
    const w = await daemonCall('loop_register', { role: 'worker', label });
    const r = await daemonCall('loop_register', { role: 'reviewer', label });
    if (!w.key.startsWith('WRK-') || !r.key.startsWith('REV-')) throw new Error('bad keys');

    say(`3. link ${w.key} + ${r.key}`);
    const link = await daemonCall('loop_link', { key_a: w.key, key_b: r.key });
    if (!link.pair) throw new Error('no pair id');

    say('4. reviewer blocks on await_work; worker submits 300ms later');
    const workP = daemonCall('await_work', { key: r.key, timeout_ms: 10_000 });
    await sleep(300);
    const sub = await daemonCall('submit_for_review', {
      key: w.key,
      handoff: { summary: 'selftest unit of work', stop_reason: 'completed', changed_files: [], confidence: 'high' }
    });
    const work = await workP;
    if (work.status !== 'work' || work.ticket !== sub.ticket) throw new Error(`await_work got ${JSON.stringify(work).slice(0, 200)}`);

    say(`5. worker blocks on await_ruling(${sub.ticket}); reviewer rules 300ms later`);
    const rulP = daemonCall('await_ruling', { key: w.key, ticket: sub.ticket, timeout_ms: 10_000 });
    await sleep(300);
    await daemonCall('submit_ruling', {
      key: r.key, ticket: sub.ticket,
      ruling: { verdict: 'approve', relay: 'Selftest relay text — verbatim.', stop_when: 'n/a', done: true, standing_rule: 'Selftest: rules file append works.' }
    });
    const rul = await rulP;
    if (rul.status !== 'ruled' || rul.ruling.relay !== 'Selftest relay text — verbatim.') throw new Error('relay mismatch');

    say('6. pending path: await_work times out cleanly');
    const pend = await daemonCall('await_work', { key: r.key, timeout_ms: 800 });
    if (pend.status !== 'pending') throw new Error('expected pending');

    say('7. standing rules readable');
    const rules = await daemonCall('get_standing_rules', { key: w.key });
    if (!rules.content.includes('Selftest: rules file append works.')) throw new Error('rule not appended');

    say('8. unlink; keys survive');
    await daemonCall('loop_unlink', { key: w.key });
    const st = await daemonCall('loop_status', {});
    if (!st.unlinked_keys.find(k => k.key === w.key)) throw new Error('worker key did not survive unlink');

    say('\nPASS — pairing, link, submit→await_work, rule→await_ruling, pending, rules, unlink all verified.');
    say(`state: ${HOME}`);
    process.exit(0);
  } catch (e) {
    console.error('\nFAIL — ' + (e.stack || e.message));
    process.exit(1);
  }
}

/* ---------------- entry ---------------- */

if (process.argv.includes('--selftest')) selftest();
else serveStdio();
