#!/usr/bin/env node
/* rl.js — tiny CLI client for the reviewloop daemon.
   Usage: node rl.js <method> ['<json params>']
   Lets any process (including a Claude session without MCP registration)
   act as a first-class participant via the daemon HTTP API. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const HOME = process.env.REVIEWLOOP_HOME || path.join(os.homedir(), '.reviewloop');
const PORTFILE = path.join(HOME, 'daemon.json');
const DAEMON = path.join(__dirname, 'daemon.js');

function readPf() { try { return JSON.parse(fs.readFileSync(PORTFILE, 'utf8')); } catch { return null; } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function health(pf) {
  return new Promise(res => {
    if (!pf) return res(false);
    const rq = http.request({ host: '127.0.0.1', port: pf.port, path: '/health' }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d).app === 'reviewloop'); } catch { res(false); } });
    });
    rq.setTimeout(1500, () => { rq.destroy(); res(false); });
    rq.on('error', () => res(false));
    rq.end();
  });
}

async function ensure() {
  let pf = readPf();
  if (await health(pf)) return pf;
  fs.mkdirSync(HOME, { recursive: true });
  spawn(process.execPath, [DAEMON], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 40; i++) { await sleep(250); pf = readPf(); if (await health(pf)) return pf; }
  throw new Error('daemon did not start');
}

async function main() {
  const method = process.argv[2];
  if (!method) { console.error('usage: node rl.js <method> [key=value ... | @params.json | {json}]'); process.exit(2); }
  let params = {};
  const rest = process.argv.slice(3);
  if (rest.length === 1 && rest[0].startsWith('@')) {
    params = JSON.parse(fs.readFileSync(rest[0].slice(1), 'utf8'));
  } else if (rest.length === 1 && rest[0].trim().startsWith('{')) {
    params = JSON.parse(rest[0]);
  } else {
    for (const a of rest) {
      const i = a.indexOf('=');
      if (i < 0) continue;
      const k = a.slice(0, i);
      let v = a.slice(i + 1);
      if (v === 'true') v = true;
      else if (v === 'false') v = false;
      else if (/^\d+$/.test(v)) v = Number(v);
      params[k] = v;
    }
  }
  const pf = await ensure();
  const body = JSON.stringify({ method, params });
  const out = await new Promise((resolve, reject) => {
    const rq = http.request({
      host: '127.0.0.1', port: pf.port, path: '/rpc', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': pf.token, 'content-length': Buffer.byteLength(body) }
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ code: r.statusCode, d })); });
    rq.setTimeout(175_000, () => rq.destroy(new Error('timeout')));
    rq.on('error', reject);
    rq.end(body);
  });
  console.log(out.d);
  process.exit(out.code >= 400 ? 1 : 0);
}

main().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
