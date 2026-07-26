#!/usr/bin/env node
/* reviewloop daemon — single local process owning pair/ticket state.
   Zero dependencies. Node >= 18. Binds 127.0.0.1 on an ephemeral port,
   writes {pid, port, token} to $REVIEWLOOP_HOME/daemon.json.
   Shims (stdio MCP servers spawned by Codex / Claude) talk to it over HTTP. */

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const HOME = process.env.REVIEWLOOP_HOME || path.join(os.homedir(), '.reviewloop');
const PORTFILE = path.join(HOME, 'daemon.json');
const STATEFILE = path.join(HOME, 'state.json');
const LEDGER = path.join(HOME, 'ledger.jsonl');
const RULESFILE = path.join(HOME, 'standing-rules.md');
const LOGFILE = path.join(HOME, 'daemon.log');

const KEY_TTL_UNLINKED_MS = 60 * 60 * 1000;      // unlinked keys expire after 1h
const AWAIT_HARD_MAX_MS = 160_000;               // never hold a long-poll longer (fits tool_timeout_sec=180)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

fs.mkdirSync(HOME, { recursive: true });

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  try { fs.appendFileSync(LOGFILE, line); } catch {}
}

/* ---------------- state ---------------- */

let state = { keys: {}, pairs: {}, tickets: {}, seq: 0 };
try {
  state = JSON.parse(fs.readFileSync(STATEFILE, 'utf8'));
  if (!state.keys || !state.pairs || !state.tickets) throw new Error('bad shape');
} catch { /* fresh state */ }

function saveState() {
  const tmp = STATEFILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, STATEFILE);
}

function ledger(event, data) {
  const rec = { ts: new Date().toISOString(), event, ...data };
  try { fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n'); } catch {}
}

function rid(prefix, n = 4) {
  let s = '';
  const b = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return `${prefix}-${s}`;
}

function now() { return Date.now(); }

/* ---------------- waiters (long-poll) ---------------- */
/* kind: 'work:<pairId>'  or  'ruling:<ticketId>' */
const waiters = new Map(); // kind -> [{resolve, timer}]

function waitFor(kind, timeoutMs) {
  return new Promise((resolve) => {
    const entry = { resolve: null, timer: null };
    entry.resolve = (val) => {
      clearTimeout(entry.timer);
      const arr = waiters.get(kind) || [];
      const i = arr.indexOf(entry);
      if (i >= 0) arr.splice(i, 1);
      resolve(val);
    };
    entry.timer = setTimeout(() => entry.resolve({ timeout: true }), timeoutMs);
    if (!waiters.has(kind)) waiters.set(kind, []);
    waiters.get(kind).push(entry);
  });
}

function wake(kind, val) {
  const arr = waiters.get(kind) || [];
  for (const w of [...arr]) w.resolve(val);
}

/* ---------------- helpers ---------------- */

function expireKeys() {
  const t = now();
  for (const [k, v] of Object.entries(state.keys)) {
    if (!v.pair && t - v.created > KEY_TTL_UNLINKED_MS) {
      delete state.keys[k];
      ledger('key_expired', { key: k });
    }
  }
}

function keyOf(params) {
  const k = (params.key || '').trim().toUpperCase();
  const rec = state.keys[k];
  if (!rec) throw uerr(`Unknown or expired key "${params.key}". Call loop_register first.`);
  rec.last_seen = now();
  return rec;
}

function pairOf(keyRec) {
  const p = keyRec.pair && state.pairs[keyRec.pair];
  if (!p || p.ended) throw uerr(`Key ${keyRec.key} is not part of an active pair. Link it with loop_link first.`);
  return p;
}

function uerr(msg) { const e = new Error(msg); e.user = true; return e; }

function openTickets(pairId) {
  return Object.values(state.tickets).filter(t => t.pair === pairId && !t.ruling);
}

/* ---------------- tool implementations ---------------- */

const methods = {

  health() { return { app: 'reviewloop', pid: process.pid, version: '0.1.0' }; },

  loop_register({ role, label }) {
    if (role !== 'worker' && role !== 'reviewer') throw uerr('role must be "worker" or "reviewer".');
    if (!label || typeof label !== 'string') throw uerr('label is required (a short run name, e.g. "p04").');
    expireKeys();
    const key = rid(role === 'worker' ? 'WRK' : 'REV');
    state.keys[key] = { key, role, label: label.trim(), created: now(), last_seen: now(), pair: null };
    saveState();
    ledger('registered', { key, role, label });
    const counterpart = Object.values(state.keys).find(
      k => !k.pair && k.label === label.trim() && k.role !== role
    );
    return {
      key,
      role,
      label: label.trim(),
      next_steps: [
        `Show this key to the human: ${key}`,
        counterpart
          ? `A ${counterpart.role} key with the same label exists: ${counterpart.key}. The human (or either side) can now call loop_link with both keys.`
          : `Wait for the ${role === 'worker' ? 'reviewer' : 'worker'} to register, then the human links the two keys with loop_link.`,
        role === 'worker'
          ? 'After linking: do one unit of work, then call submit_for_review, then await_ruling.'
          : 'After linking: call await_work to wait for the first submission. It returns "pending" on timeout — just call it again.'
      ]
    };
  },

  loop_link({ key_a, key_b, repo }) {
    const a = state.keys[(key_a || '').trim().toUpperCase()];
    const b = state.keys[(key_b || '').trim().toUpperCase()];
    if (!a || !b) throw uerr('Both keys must exist and be unexpired.');
    if (a.pair || b.pair) throw uerr('A key can only belong to one active pair. Unlink first.');
    if (a.role === b.role) throw uerr(`Both keys are role "${a.role}" — a pair needs one worker and one reviewer.`);
    const worker = a.role === 'worker' ? a : b;
    const reviewer = a.role === 'reviewer' ? a : b;
    if (repo && !fs.existsSync(repo)) throw uerr(`repo path does not exist: ${repo}`);
    const id = rid('PAIR');
    state.pairs[id] = {
      id, worker: worker.key, reviewer: reviewer.key,
      label: worker.label, repo: repo || null,
      created: now(), ended: null
    };
    worker.pair = id; reviewer.pair = id;
    saveState();
    ledger('linked', { pair: id, worker: worker.key, reviewer: reviewer.key, label: worker.label, repo: repo || null });
    return {
      pair: id,
      worker: worker.key, reviewer: reviewer.key, label: worker.label,
      repo: repo || null,
      message: 'Pair active. Worker: submit_for_review after each unit of work. Reviewer: await_work.'
    };
  },

  loop_unlink({ key }) {
    const rec = keyOf({ key });
    const p = pairOf(rec);
    p.ended = now();
    const w = state.keys[p.worker]; if (w) w.pair = null;
    const r = state.keys[p.reviewer]; if (r) r.pair = null;
    saveState();
    ledger('unlinked', { pair: p.id, by: rec.key });
    wake('work:' + p.id, { unlinked: true });
    for (const t of openTickets(p.id)) wake('ruling:' + t.id, { unlinked: true });
    return {
      message: `Pair ${p.id} ended. Both keys remain valid and can be re-linked (e.g. a fresh reviewer thread registers a new key, then loop_link it with the surviving worker key).`
    };
  },

  loop_status({ key }) {
    expireKeys();
    if (key) {
      const rec = keyOf({ key });
      const p = rec.pair ? state.pairs[rec.pair] : null;
      return {
        key: rec.key, role: rec.role, label: rec.label,
        paired: !!p,
        pair: p ? {
          id: p.id, label: p.label, repo: p.repo,
          open_tickets: openTickets(p.id).map(t => ({ id: t.id, submitted: new Date(t.submitted).toISOString() }))
        } : null
      };
    }
    const unlinked = Object.values(state.keys).filter(k => !k.pair)
      .map(k => ({ key: k.key, role: k.role, label: k.label }));
    const pairs = Object.values(state.pairs).filter(p => !p.ended)
      .map(p => ({ id: p.id, label: p.label, worker: p.worker, reviewer: p.reviewer, open_tickets: openTickets(p.id).length }));
    const suggestions = [];
    for (const w of unlinked.filter(k => k.role === 'worker')) {
      const r = unlinked.find(k => k.role === 'reviewer' && k.label === w.label);
      if (r) suggestions.push(`loop_link ${w.key} ${r.key}  (shared label "${w.label}")`);
    }
    return { unlinked_keys: unlinked, active_pairs: pairs, suggestions };
  },

  submit_for_review({ key, handoff }) {
    const rec = keyOf({ key });
    if (rec.role !== 'worker') throw uerr('Only the worker key submits work. The reviewer uses submit_ruling.');
    const p = pairOf(rec);
    if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) {
      throw uerr('handoff must be a JSON object. Recommended fields: summary, stop_reason, changed_files, commands_run, tests, blockers, questions, confidence.');
    }
    const warnings = [];
    if (!handoff.summary && !handoff.stop_reason) warnings.push('handoff has neither "summary" nor "stop_reason" — the reviewer will lack context.');
    if (handoff.changed_files && !Array.isArray(handoff.changed_files)) warnings.push('"changed_files" should be an array of paths.');
    const id = rid('T');
    state.tickets[id] = { id, pair: p.id, handoff, submitted: now(), ruling: null, ruled_at: null };
    saveState();
    ledger('submitted', { pair: p.id, ticket: id, summary: String(handoff.summary || handoff.stop_reason || '').slice(0, 300) });
    wake('work:' + p.id, { ticket: id });
    return {
      ticket: id,
      status: 'submitted',
      warnings,
      next: `Call await_ruling with ticket "${id}". It returns status:"pending" on timeout — call it again until you get the ruling.`
    };
  },

  async await_ruling({ key, ticket, timeout_ms }) {
    const rec = keyOf({ key });
    if (rec.role !== 'worker') throw uerr('await_ruling is a worker tool.');
    const p = pairOf(rec);
    const t = state.tickets[(ticket || '').trim().toUpperCase()];
    if (!t || t.pair !== p.id) throw uerr(`Unknown ticket "${ticket}" for this pair.`);
    if (t.ruling) return ruled(t);
    const ms = clampAwait(timeout_ms);
    const res = await waitFor('ruling:' + t.id, ms);
    if (res.unlinked) return { status: 'unlinked', message: 'The pair was unlinked while waiting.' };
    if (res.timeout) return {
      status: 'pending',
      ticket: t.id,
      waited_ms: ms,
      message: 'No ruling yet (the human may still be reviewing). Call await_ruling again with the same ticket.'
    };
    return ruled(state.tickets[t.id]);
  },

  async await_work({ key, timeout_ms }) {
    const rec = keyOf({ key });
    if (rec.role !== 'reviewer') throw uerr('await_work is a reviewer tool.');
    const p = pairOf(rec);
    const open = openTickets(p.id).sort((x, y) => x.submitted - y.submitted);
    if (open.length) return workItem(open[0], p);
    const ms = clampAwait(timeout_ms);
    const res = await waitFor('work:' + p.id, ms);
    if (res.unlinked) return { status: 'unlinked', message: 'The pair was unlinked while waiting.' };
    if (res.timeout) return {
      status: 'pending',
      waited_ms: ms,
      message: 'No submission yet. Call await_work again.'
    };
    const t = state.tickets[res.ticket];
    return t ? workItem(t, p) : { status: 'pending', message: 'Ticket vanished; call await_work again.' };
  },

  submit_ruling({ key, ticket, ruling }) {
    const rec = keyOf({ key });
    if (rec.role !== 'reviewer') throw uerr('Only the reviewer key rules. The worker uses submit_for_review.');
    const p = pairOf(rec);
    const t = state.tickets[(ticket || '').trim().toUpperCase()];
    if (!t || t.pair !== p.id) throw uerr(`Unknown ticket "${ticket}" for this pair.`);
    if (t.ruling) throw uerr(`Ticket ${t.id} already has a ruling.`);
    if (!ruling || typeof ruling !== 'object') throw uerr('ruling must be a JSON object.');
    const VER = ['approve', 'revise', 'rule', 'abort'];
    if (!VER.includes(ruling.verdict)) throw uerr(`ruling.verdict must be one of ${VER.join(' | ')}.`);
    if (ruling.verdict !== 'abort' && (!ruling.relay || !String(ruling.relay).trim())) {
      throw uerr('ruling.relay is required (the exact text handed to the worker, verbatim) unless verdict is "abort".');
    }
    const warnings = [];
    if (ruling.verdict !== 'abort' && !ruling.stop_when) warnings.push('No stop_when — the worker will pick its own stopping point.');
    if (ruling.done === undefined) ruling.done = false;
    t.ruling = {
      verdict: ruling.verdict,
      relay: ruling.relay || '',
      stop_when: ruling.stop_when || null,
      expected: ruling.expected || null,
      do_not: Array.isArray(ruling.do_not) ? ruling.do_not : [],
      done: !!ruling.done
    };
    t.ruled_at = now();
    if (ruling.standing_rule && String(ruling.standing_rule).trim()) {
      appendRule(String(ruling.standing_rule).trim());
      ledger('standing_rule', { pair: p.id, ticket: t.id, rule: String(ruling.standing_rule).trim() });
    }
    saveState();
    ledger('ruled', { pair: p.id, ticket: t.id, verdict: t.ruling.verdict, done: t.ruling.done });
    wake('ruling:' + t.id, { ticket: t.id });
    return { ticket: t.id, status: 'ruled', verdict: t.ruling.verdict, done: t.ruling.done, warnings };
  },

  get_standing_rules() {
    ensureRulesFile();
    return { path: RULESFILE, content: fs.readFileSync(RULESFILE, 'utf8') };
  },

  async get_checks({ key, ticket }) {
    const rec = keyOf({ key });
    const p = pairOf(rec);
    const t = state.tickets[(ticket || '').trim().toUpperCase()];
    if (!t || t.pair !== p.id) throw uerr(`Unknown ticket "${ticket}" for this pair.`);
    if (!p.repo) {
      return { status: 'could_not_verify', reason: 'No repo attached to this pair. Pass repo:"<path>" at loop_link time to enable git checks.' };
    }
    const reported = Array.isArray(t.handoff.changed_files) ? t.handoff.changed_files.map(normPath) : null;
    try {
      const [diffOut, statusOut] = await Promise.all([
        git(p.repo, ['diff', '--name-only', 'HEAD']),
        git(p.repo, ['status', '--porcelain'])
      ]);
      const actual = diffOut.split('\n').map(s => s.trim()).filter(Boolean).map(normPath);
      const untracked = statusOut.split('\n').filter(l => l.startsWith('??')).map(l => normPath(l.slice(3).trim()));
      if (reported === null) {
        return {
          status: 'partial',
          reason: 'handoff.changed_files missing — cannot compare report vs reality.',
          actual_changed: actual, untracked
        };
      }
      const missing_in_report = actual.filter(f => !reported.includes(f));
      const extra_in_report = reported.filter(f => !actual.includes(f));
      return {
        status: missing_in_report.length || extra_in_report.length ? 'mismatch' : 'match',
        reported, actual_changed: actual,
        missing_in_report, extra_in_report, untracked
      };
    } catch (e) {
      return { status: 'could_not_verify', reason: `git failed: ${e.message}` };
    }
  }
};

function clampAwait(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 25_000;
  return Math.min(n, AWAIT_HARD_MAX_MS);
}

function ruled(t) {
  return { status: 'ruled', ticket: t.id, ruling: t.ruling };
}

function workItem(t, p) {
  return {
    status: 'work',
    ticket: t.id,
    submitted: new Date(t.submitted).toISOString(),
    handoff: t.handoff,
    repo: p.repo,
    next: `Review it (use get_checks for git verification if a repo is attached), draft the ruling, get the human's go-ahead, then call submit_ruling with ticket "${t.id}".`
  };
}

function normPath(s) { return s.replace(/\\/g, '/'); }

function git(repo, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, ...args], { timeout: 15_000, windowsHide: true },
      (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}

function ensureRulesFile() {
  if (!fs.existsSync(RULESFILE)) {
    fs.writeFileSync(RULESFILE,
      '# Standing rules\n\nDurable policies for the review loop. The reviewer should curate this file — merge and supersede rules rather than letting it grow.\n\n## Rules\n');
  }
}

function appendRule(text) {
  ensureRulesFile();
  fs.appendFileSync(RULESFILE, `- [${new Date().toISOString().slice(0, 10)}] ${text}\n`);
}

/* ---------------- HTTP server ---------------- */

const TOKEN = crypto.randomBytes(16).toString('hex');

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(methods.health()));
  }
  if (req.method !== 'POST' || req.url !== '/rpc') { res.writeHead(404); return res.end(); }
  if (req.headers['x-auth'] !== TOKEN) { res.writeHead(403); return res.end('{"error":"bad token"}'); }
  let body = '';
  req.on('data', c => { body += c; if (body.length > 2_000_000) req.destroy(); });
  req.on('end', async () => {
    let out, code = 200;
    try {
      const { method, params } = JSON.parse(body || '{}');
      const fn = methods[method];
      if (!fn) throw uerr(`Unknown method "${method}"`);
      out = await fn.call(methods, params || {});
    } catch (e) {
      code = e.user ? 400 : 500;
      out = { error: e.message };
      if (!e.user) log('ERR', e.stack || e.message);
    }
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});

if (process.argv.includes('--stop')) {
  try {
    const pf = JSON.parse(fs.readFileSync(PORTFILE, 'utf8'));
    http.request({ host: '127.0.0.1', port: pf.port, path: '/rpc', method: 'POST', headers: { 'x-auth': pf.token } })
      .on('error', () => process.exit(0)).end();
    try { process.kill(pf.pid); } catch {}
    console.log('stopped');
  } catch { console.log('not running'); }
  process.exit(0);
}

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const tmp = PORTFILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, port, token: TOKEN, started: new Date().toISOString() }));
  fs.renameSync(tmp, PORTFILE);
  log(`daemon up pid=${process.pid} port=${port} home=${HOME}`);
  /* singleton: if another daemon later owns the portfile, exit quietly */
  setInterval(() => {
    try {
      const pf = JSON.parse(fs.readFileSync(PORTFILE, 'utf8'));
      if (pf.pid !== process.pid) { log('superseded, exiting'); process.exit(0); }
    } catch {
      const t2 = PORTFILE + '.tmp';
      fs.writeFileSync(t2, JSON.stringify({ pid: process.pid, port, token: TOKEN, started: new Date().toISOString() }));
      fs.renameSync(t2, PORTFILE);
    }
  }, 60_000).unref();
});

process.on('uncaughtException', e => log('UNCAUGHT', e.stack || e.message));
