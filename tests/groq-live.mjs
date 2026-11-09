// #ash Mesh — LIVE Groq integration test.
//
// This is the only test that makes a real network call to Groq. It boots the real
// server with the real GROQ_API_KEY and drives /api/ai/chat and /api/ai/assist exactly
// as the browser does. It exists so "the integration works" is proven by a real
// provider response, not by code inspection.
//
//   npm run test:groq
//
// Exit codes: 0 = every live check passed, 1 = a check failed, 2 = skipped (no key).
// The key itself is never printed; every assertion scans responses for a leaked key.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const KEY = process.env.GROQ_API_KEY || '';
const KEY_PATTERN = /gsk_[A-Za-z0-9]{20,}/;

if (!KEY) {
  console.log('SKIP  GROQ_API_KEY is not set in this environment — no live call attempted.');
  console.log('      Set it in Settings → Environment Variables, then rerun: npm run test:groq');
  process.exit(2);
}

const results = [];
let failures = 0;
function check(name, condition, detail) {
  const ok = !!condition;
  if (!ok) failures += 1;
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ↳ ${detail}`}`);
}

function makeClient(base) {
  const cookies = new Map();
  let csrf = null;
  const absorb = (res) => {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const raw of list) {
      const pair = raw.split(';')[0];
      const i = pair.indexOf('=');
      if (i < 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (value === '') cookies.delete(name);
      else cookies.set(name, value);
      if (name === 'ash_csrf') csrf = value || null;
    }
  };
  return async function request(method, endpoint, body) {
    const headers = {};
    if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrf && !['GET', 'HEAD'].includes(method)) headers['x-csrf-token'] = csrf;
    const res = await fetch(base + endpoint, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    absorb(res);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json, text };
  };
}

async function boot({ port, dataDir, extraEnv = {} }) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      DB_PATH: path.join(dataDir, 'live.db'),
      FORCE_INSECURE_COOKIES: '1',
      FOUNDER_EMAIL: 'founder@ashmesh.live',
      NODE_ENV: 'test',
      GROQ_API_KEY: KEY,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode})\n${log}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, log: () => log };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not start\n${log}`);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ash-groq-live-'));
const PORT = Number(process.env.GROQ_TEST_PORT || 4611);
let main = null;
let broken = null;

try {
  main = await boot({ port: PORT, dataDir });
  const api = makeClient(`http://127.0.0.1:${PORT}`);

  const reg = await api('POST', '/api/auth/register', {
    email: 'groq-live@ashmesh.test',
    username: 'groqlive',
    password: 'GroqLivePass123',
    fullName: 'Groq Live Tester',
  });
  check('test user registers against the real server', reg.status === 201 && !!reg.body?.user?.id, `status=${reg.status}`);

  const status = await api('GET', '/api/ai/status');
  check(
    'server reports Groq as configured',
    status.status === 200 && status.body?.configured === true,
    JSON.stringify({ configured: status.body?.configured, model: status.body?.model })
  );
  check('status response does not contain the API key', !KEY_PATTERN.test(status.text), 'a gsk_ token appeared in /ai/status');

  // --- The real call -------------------------------------------------------
  const started = Date.now();
  const chat = await api('POST', '/api/ai/chat', {
    messages: [{ role: 'user', content: 'Reply with exactly this token and nothing else: ASH_MESH_LIVE_OK' }],
  });
  const latency = Date.now() - started;

  check('live Groq chat request succeeds', chat.status === 200, `status=${chat.status} ${chat.text.slice(0, 200)}`);
  check(
    'live Groq returns real assistant text',
    typeof chat.body?.reply === 'string' && chat.body.reply.trim().length > 0,
    JSON.stringify(chat.body?.reply ?? null).slice(0, 160)
  );
  check('response is attributed to the groq provider', chat.body?.provider === 'groq', String(chat.body?.provider));
  check('response reports the model actually used', typeof chat.body?.model === 'string' && chat.body.model.length > 0, String(chat.body?.model));
  check('chat response never contains the API key', !KEY_PATTERN.test(chat.text), 'a gsk_ token appeared in the chat response');
  console.log(`        ↳ ${latency}ms · model=${chat.body?.model} · reply=${JSON.stringify((chat.body?.reply || '').slice(0, 90))}`);

  // --- A second real capability: writing assistance ------------------------
  const assist = await api('POST', '/api/ai/assist', {
    feature: 'compose',
    text: 'i went to the market yesterday and buy rice for my family',
  });
  check('live Groq writing assistance succeeds', assist.status === 200 && typeof assist.body?.text === 'string' && assist.body.text.length > 0, `status=${assist.status} ${assist.text.slice(0, 180)}`);
  check('assist response never contains the API key', !KEY_PATTERN.test(assist.text), 'a gsk_ token appeared in the assist response');

  // --- Real failure path: an unusable model must fail safely ---------------
  const brokenPort = PORT + 1;
  broken = await boot({ port: brokenPort, dataDir, extraEnv: { GROQ_MODEL: 'ash-mesh-model-that-does-not-exist' } });
  const brokenApi = makeClient(`http://127.0.0.1:${brokenPort}`);
  const reg2 = await brokenApi('POST', '/api/auth/register', {
    email: 'groq-fail@ashmesh.test',
    username: 'groqfail',
    password: 'GroqFailPass123',
    fullName: 'Groq Failure Tester',
  });
  check('second user registers on the failure server', reg2.status === 201, `status=${reg2.status}`);

  const failed = await brokenApi('POST', '/api/ai/chat', {
    messages: [{ role: 'user', content: 'This request should fail at the provider.' }],
  });
  check('a provider failure returns an error status, not a fake reply', failed.status >= 400 && !failed.body?.reply, `status=${failed.status} ${failed.text.slice(0, 200)}`);
  check(
    'the failure carries a friendly message and a machine-readable code',
    typeof failed.body?.error === 'string' && typeof failed.body?.message === 'string' && failed.body.message.length > 0,
    JSON.stringify({ error: failed.body?.error, message: failed.body?.message }).slice(0, 200)
  );
  check('a failed request never leaks the API key', !KEY_PATTERN.test(failed.text), 'a gsk_ token appeared in the failure response');
  check('the server did not crash after a provider failure', broken.child.exitCode === null, 'server process exited');

  console.log(`\n${failures === 0 ? 'ALL LIVE GROQ CHECKS PASSED' : `${failures} LIVE CHECK(S) FAILED`} — ${results.length} checks`);
} catch (err) {
  failures += 1;
  console.error(`FAIL  live Groq test could not complete: ${err.message}`);
} finally {
  for (const s of [main, broken]) {
    if (!s) continue;
    try { s.child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(failures === 0 ? 0 : 1);
