// #ash Mesh — Stage F: security hardening regressions.
//
// Boots the REAL server against isolated temporary data directories and proves:
//
//   registration can never mint Founder authority, and the reserved Founder address is
//     answered exactly like any other taken address (no account-takeover path)
//   the Founder is still provisioned from server configuration at boot, and an existing
//     non-Founder row is NOT promoted without the configured credential
//   Founder-only surfaces reject anonymous callers, members and elevated staff
//   a leftover permission grant on a demoted member is inert, while a real admin grant
//     still works (the fix must not over-tighten)
//   Founder authority cannot be reassigned, including by the Founder themselves
//   changing a password invalidates every other session but keeps the current one
//   authenticated writes without a CSRF token are refused
//   a provider webhook with a forged signature never succeeds
//   no password material appears in an API response
//   repeated failed logins are rate limited
//
//   node tests/security-hardening.test.mjs
//
// Everything runs on 127.0.0.1 with disposable data. No LIVE database, no deployment,
// no real provider and no real user data.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const FOUNDER_EMAIL = 'founder@ashmesh.test';
const FOUNDER_PASSWORD = 'FounderPass123';
const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
let failures = 0;

function check(name, condition, detail) {
  const ok = !!condition;
  if (!ok) failures += 1;
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        \u21b3 ${detail}`}`);
  return ok;
}

/* ------------------------------- http client ------------------------------ */

function makeClient() {
  const cookies = new Map();
  async function request(method, pathname, { json, headers = {} } = {}) {
    const h = { ...headers };
    if (cookies.size) h.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const csrf = cookies.get('ash_csrf');
    if (csrf && method !== 'GET') h['x-csrf-token'] = csrf;
    let body;
    if (json !== undefined) {
      h['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(BASE + pathname, { method, headers: h, body });
    for (const cookie of res.headers.getSetCookie?.() || []) {
      const pair = cookie.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    let data = null;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { status: res.status, data, text, cookies };
  }
  return {
    get: (p, o) => request('GET', p, o),
    post: (p, o) => request('POST', p, o),
    raw: request,
    cookies,
  };
}

async function waitReady() {
  for (let i = 0; i < 200; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.status < 500) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become ready on ${BASE}`);
}

function bootServer({ dataDir, env = {} }) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      DB_PATH: path.join(dataDir, 'ash-mesh.db'),
      FORCE_INSECURE_COOKIES: '1',
      FOUNDER_EMAIL,
      FOUNDER_PASSWORD,
      GROQ_API_KEY: '',
      RESEND_API_KEY: '',
      PAYSTACK_SECRET_KEY: '',
      BACKUP_SCHEDULER: 'off',
      NODE_ENV: 'test',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => {
    log += d.toString();
  });
  child.stderr.on('data', (d) => {
    log += d.toString();
  });
  return { child, log: () => log };
}

async function stopServer(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 4000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function withDb(dataDir, fn) {
  const db = new Database(path.join(dataDir, 'ash-mesh.db'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const member = { email: 'member@ashmesh.test', username: 'memberone', password: 'MemberPass123', fullName: 'Member One' };
const victim = { email: 'victim@ashmesh.test', username: 'victimone', password: 'VictimPass123', fullName: 'Victim One' };

async function register(client, account) {
  return client.post('/api/auth/register', { json: account });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ash-stage-f-'));
  let server = bootServer({ dataDir });
  await waitReady();

  /* ------------------- 1. registration cannot mint Founder ------------------ */

  const attacker = makeClient();
  const takeover = await register(attacker, {
    email: FOUNDER_EMAIL,
    username: 'impostor',
    password: 'Impostor123',
    fullName: 'Impostor',
  });
  check('registering the reserved Founder email is refused', takeover.status === 409, `status ${takeover.status}`);
  check(
    'the refusal is indistinguishable from any taken address',
    takeover.data?.error === 'email_taken',
    `error ${takeover.data?.error}`
  );

  const attackerLogin = await attacker.post('/api/auth/login', {
    json: { identifier: FOUNDER_EMAIL, password: 'Impostor123' },
  });
  check('the attacker-chosen password never binds to the Founder account', attackerLogin.status === 401, `status ${attackerLogin.status}`);

  /* ------------------- 2. Founder still provisioned from config ------------- */

  const founder = makeClient();
  const founderLogin = await founder.post('/api/auth/login', {
    json: { identifier: FOUNDER_EMAIL, password: FOUNDER_PASSWORD },
  });
  check('the configured Founder credential still signs in', founderLogin.status === 200, `status ${founderLogin.status}`);
  check('the signed-in Founder carries Founder authority', founderLogin.data?.user?.isFounder === true, JSON.stringify(founderLogin.data?.user?.isFounder));

  const founderDash = await founder.get('/api/founder/dashboard');
  check('the Founder can open the Founder dashboard', founderDash.status === 200, `status ${founderDash.status}`);

  /* ------------------- 3. Founder-only surfaces reject others --------------- */

  const anonymous = makeClient();
  const anonDash = await anonymous.get('/api/founder/dashboard');
  check('anonymous callers cannot read the Founder dashboard', anonDash.status === 401, `status ${anonDash.status}`);

  const memberClient = makeClient();
  const memberReg = await register(memberClient, member);
  check('a normal member can register', memberReg.status === 201, `status ${memberReg.status} ${memberReg.text?.slice(0, 160)}`);
  const memberId = memberReg.data?.user?.id;

  const memberDash = await memberClient.get('/api/founder/dashboard');
  check('a member is denied the Founder dashboard', memberDash.status === 403, `status ${memberDash.status}`);

  const memberEditor = await memberClient.get('/api/founder/editor/status');
  check('a member is denied the Founder editor', memberEditor.status === 403, `status ${memberEditor.status}`);

  /* ------------------- 4. stale grants are inert, real grants work ---------- */

  withDb(dataDir, (db) => {
    db.prepare('UPDATE users SET role = ?, permissions = ? WHERE id = ?').run('member', JSON.stringify(['users.view']), memberId);
  });
  const staleGrant = await memberClient.get('/api/admin/overview');
  check('a permission left on a demoted member no longer grants admin access', staleGrant.status === 403, `status ${staleGrant.status}`);

  withDb(dataDir, (db) => {
    db.prepare('UPDATE users SET role = ?, permissions = ? WHERE id = ?').run('admin', JSON.stringify(['users.view']), memberId);
  });
  const realGrant = await memberClient.get('/api/admin/overview');
  check('a genuine admin grant still works (no over-tightening)', realGrant.status === 200, `status ${realGrant.status}`);

  withDb(dataDir, (db) => {
    db.prepare('UPDATE users SET role = ?, permissions = ? WHERE id = ?').run('member', '[]', memberId);
  });

  /* ------------------- 5. privilege escalation attempts -------------------- */

  const escalate = await memberClient.post(`/api/admin/users/${memberId}/role`, { json: { role: 'founder' } });
  check('a member cannot grant themselves the Founder role', escalate.status === 403, `status ${escalate.status}`);

  const founderId = founderLogin.data?.user?.id;
  const demote = await founder.post(`/api/admin/users/${founderId}/role`, { json: { role: 'member' } });
  check('Founder authority cannot be reassigned, even by the Founder', demote.status === 403, `status ${demote.status}`);

  /* ------------------- 6. password change kills other sessions ------------- */

  const deviceA = makeClient();
  const deviceB = makeClient();
  await deviceA.post('/api/auth/login', { json: { identifier: member.email, password: member.password } });
  await deviceB.post('/api/auth/login', { json: { identifier: member.email, password: member.password } });
  const beforeB = await deviceB.get('/api/auth/me');
  check('the second device starts signed in', beforeB.data?.user?.id === memberId, `user ${beforeB.data?.user?.id}`);

  const changed = await deviceA.post('/api/auth/password/change', {
    json: { currentPassword: member.password, newPassword: 'MemberPass456' },
  });
  check('the password change succeeds', changed.status === 200, `status ${changed.status} ${changed.text?.slice(0, 160)}`);

  const afterB = await deviceB.get('/api/auth/me');
  check('the other device is signed out by the password change', afterB.data?.user === null, `user ${JSON.stringify(afterB.data?.user)}`);
  const afterA = await deviceA.get('/api/auth/me');
  check('the device that changed the password stays signed in', afterA.data?.user?.id === memberId, `user ${afterA.data?.user?.id}`);
  member.password = 'MemberPass456';

  /* ------------------- 7. CSRF ---------------------------------------------- */

  const cookieOnly = [...deviceA.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const noCsrf = await fetch(`${BASE}/api/users/me`, {
    method: 'PATCH',
    headers: { cookie: cookieOnly, 'content-type': 'application/json' },
    body: JSON.stringify({ bio: 'csrf attempt' }),
  });
  check('an authenticated write without a CSRF token is refused', noCsrf.status === 403, `status ${noCsrf.status}`);

  /* ------------------- 8. forged payment webhook ---------------------------- */

  const forged = await anonymous.post('/api/market/payments/webhook', {
    json: { event: 'charge.success', data: { reference: 'ash_fake', amount: 100000, currency: 'NGN', status: 'success' } },
    headers: { 'x-paystack-signature': 'deadbeef' },
  });
  check('a webhook with a forged signature never succeeds', forged.status !== 200, `status ${forged.status}`);

  /* ------------------- 9. no password material in responses ---------------- */

  const me = await founder.get('/api/auth/me');
  const leaked = /password_hash|passwordHash|scrypt|FOUNDER_PASSWORD|FounderPass123/i.test(me.text || '');
  check('no password material appears in an API response', !leaked, 'response contained password-like material');

  /* ------------------- 10. failed logins are rate limited ------------------ */

  let sawLimit = false;
  let lastStatus = 0;
  for (let i = 0; i < 18; i += 1) {
    const attempt = await anonymous.post('/api/auth/login', {
      json: { identifier: 'nobody@ashmesh.test', password: `WrongPass${i}` },
    });
    lastStatus = attempt.status;
    if (attempt.status === 429) {
      sawLimit = true;
      break;
    }
  }
  check('repeated failed logins are rate limited', sawLimit, `last status ${lastStatus}`);

  /* ------------------- 11. no promotion without the operator credential ---- */

  // A victim account created as an ordinary member while the operator's FOUNDER_EMAIL still
  // points somewhere else.
  const victimClient = makeClient();
  const victimReg = await register(victimClient, victim);
  check('the victim account registers as an ordinary member', victimReg.status === 201, `status ${victimReg.status}`);

  await stopServer(server.child);

  // Restart with FOUNDER_EMAIL pointed at that existing address and NO configured password:
  // an ordinary account must never inherit Founder authority on boot.
  server = bootServer({ dataDir, env: { FOUNDER_EMAIL: victim.email, FOUNDER_PASSWORD: '' } });
  await waitReady();

  const victimAfter = makeClient();
  const victimLogin = await victimAfter.post('/api/auth/login', { json: { identifier: victim.email, password: victim.password } });
  check('the existing account still signs in after FOUNDER_EMAIL points at it', victimLogin.status === 200, `status ${victimLogin.status}`);

  const victimMe = await victimAfter.get('/api/auth/me');
  check('an existing account using the Founder email is not promoted on boot', victimMe.data?.user?.isFounder === false, JSON.stringify(victimMe.data?.user?.isFounder));
  const victimDash = await victimAfter.get('/api/founder/dashboard');
  check('the unpromoted account cannot reach the Founder dashboard', victimDash.status === 403, `status ${victimDash.status}`);

  await stopServer(server.child);

  /* --------------------------------- summary ------------------------------- */

  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  if (failures) {
    console.log(`${failures} FAILED`);
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.exit(1);
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
