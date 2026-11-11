// #ash Mesh — Stage C: Founder Editor discoverability, approval workflow and rollback.
//
// Boots the REAL server against an isolated temporary database and drives the real HTTP API:
//
//   the Founder Editor is reachable from the Founder Dashboard route data
//   choosing an item + Preview creates an INERT proposal (nothing is applied)
//   only an explicit approval writes a TEST draft, and a draft never reaches users
//   the audit trail records the proposal and the applied version
//   rollback restores the previous value while keeping history
//   non-Founder accounts, other administrators, anonymous callers and a spoofed
//     "Hassan Shuaibu Adam" profile are all rejected by the server itself
//
// "LIVE" in this suite means the live version row inside this throwaway database — it is
// never the deployed application or a Supabase project.
//
//   node tests/founder-editor-discoverability.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ash-stagec-'));
const PORT = 4500 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const FOUNDER_EMAIL = 'founder@ashmesh.test';
const PASSWORD = 'FounderPass123';
const NEW_HEADING = 'Stage C preview heading 01';

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

class Client {
  constructor(label) {
    this.label = label;
    this.cookies = new Map();
    this.csrf = '';
  }

  absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const raw of list) {
      const pair = raw.split(';')[0];
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const key = pair.slice(0, index).trim();
      const value = pair.slice(index + 1);
      this.cookies.set(key, value);
      if (key === 'ash_csrf') this.csrf = value;
    }
  }

  async request(method, pathname, body) {
    const headers = {};
    if (this.cookies.size) {
      headers.cookie = [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    }
    if (method !== 'GET' && this.csrf) headers['x-csrf-token'] = this.csrf;
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + pathname, { method, headers, body: payload });
    this.absorb(res);
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, data };
  }

  get(pathname) {
    return this.request('GET', pathname);
  }

  post(pathname, body) {
    return this.request('POST', pathname, body === undefined ? {} : body);
  }
}

function headingOf(config, page) {
  if (!config || !config.pages) return '';
  const entry = config.pages[page];
  if (!entry) return '';
  if (typeof entry === 'string') return entry;
  return typeof entry.heading === 'string' ? entry.heading : '';
}

async function waitReady() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR,
    FOUNDER_EMAIL,
    FOUNDER_PASSWORD: '',
    GROQ_API_KEY: '',
    BACKUP_SCHEDULER: 'off',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });

function shutdown(code) {
  try { server.kill('SIGTERM'); } catch { /* already gone */ }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(code);
}

async function main() {
  const ready = await waitReady();
  if (!ready) {
    console.error('server never became ready\n' + serverLog.slice(-2000));
    shutdown(1);
  }

  const anon = new Client('anon');
  const founder = new Client('founder');
  const member = new Client('member');
  const admin = new Client('admin');
  const spoof = new Client('spoof');

  /* ---------- accounts ---------- */
  const founderReg = await founder.post('/api/auth/register', {
    email: FOUNDER_EMAIL, username: 'thefounder', password: PASSWORD, fullName: 'Hassan Shuaibu Adam',
  });
  check('Founder account registers', founderReg.status === 201 || founderReg.status === 200, `status ${founderReg.status}`);

  const memberReg = await member.post('/api/auth/register', {
    email: 'member@ashmesh.test', username: 'member1', password: PASSWORD, fullName: 'Ordinary Member',
  });
  check('ordinary member account registers', memberReg.status === 201 || memberReg.status === 200, `status ${memberReg.status}`);

  const adminReg = await admin.post('/api/auth/register', {
    email: 'admin@ashmesh.test', username: 'admin1', password: PASSWORD, fullName: 'Limited Admin',
  });
  check('limited administrator account registers', adminReg.status === 201 || adminReg.status === 200, `status ${adminReg.status}`);

  const spoofReg = await spoof.post('/api/auth/register', {
    email: 'spoof@ashmesh.test', username: 'hassan', password: PASSWORD, fullName: 'Hassan Shuaibu Adam',
  });
  check('account copying the Founder name registers as an ordinary user', spoofReg.status === 201 || spoofReg.status === 200, `status ${spoofReg.status}`);

  // Founder authority comes from the role record only, never from a typed name.
  const raw = new Database(path.join(DATA_DIR, 'ash-mesh.db'));
  raw.prepare("UPDATE users SET role='founder', is_founder=1 WHERE lower(email)=lower(?)").run(FOUNDER_EMAIL);
  raw.prepare("UPDATE users SET role='admin', is_founder=0 WHERE lower(email)='admin@ashmesh.test'").run();
  raw.prepare("UPDATE users SET role='user', is_founder=0 WHERE lower(email)='spoof@ashmesh.test'").run();
  const founderId = raw.prepare('SELECT id FROM users WHERE lower(email)=lower(?)').get(FOUNDER_EMAIL).id;
  const founderRow = raw.prepare('SELECT role, is_founder FROM users WHERE id=?').get(founderId);
  check('Founder role is stored server-side (role=founder, is_founder=1)', founderRow.role === 'founder' && founderRow.is_founder === 1, JSON.stringify(founderRow));
  raw.close();

  /* ---------- 1. discoverability: the Editor exists behind the dashboard ---------- */
  const status0 = await founder.get('/api/founder/editor/status');
  check('Founder can open the Founder Editor', status0.status === 200, `status ${status0.status}`);
  const registry = (status0.data && status0.data.registry) || {};
  const pages = registry.pages || [];
  const theme = registry.theme || [];
  check('Editor exposes selectable pages', pages.length > 0 && pages.some((entry) => entry.page === 'home'), JSON.stringify(pages.map((p) => p.page)));
  check('Editor exposes selectable theme values', theme.length > 0, JSON.stringify(theme.map((t) => t.key)));
  check('Editor reports the current LIVE version', !!(status0.data && status0.data.live), JSON.stringify(status0.data && status0.data.live));
  check('Editor reports the audit trail field', Array.isArray(status0.data && status0.data.events), typeof (status0.data && status0.data.events));

  const live0 = status0.data.live;
  const draft0 = status0.data.draft;
  const events0 = (status0.data.events || []).length;
  const versions0 = await founder.get('/api/founder/editor/versions');
  check('Founder can list versions', versions0.status === 200 && Array.isArray(versions0.data.versions), `status ${versions0.status}`);
  const versionCount0 = (versions0.data.versions || []).length;

  const public0 = await anon.get('/api/site-config');
  check('public site config is readable', public0.status === 200 && !!public0.data.config, `status ${public0.status}`);
  const baseline = headingOf(public0.data.config, 'home');

  /* ---------- 2. preview creates an inert proposal ---------- */
  const propose = await founder.post('/api/founder/editor/propose', {
    summary: 'Stage C test edit',
    changes: [{ op: 'set_text', page: 'home', field: 'heading', value: NEW_HEADING }],
  });
  check('Founder can make a test change (preview)', propose.status === 200 || propose.status === 201, `status ${propose.status}`);
  const proposal = propose.data && propose.data.proposal;
  check('proposal is returned in the proposed state', !!proposal && proposal.status === 'proposed', JSON.stringify(proposal && proposal.status));
  check('preview shows the proposed change', JSON.stringify(proposal || {}).includes(NEW_HEADING), JSON.stringify(proposal && proposal.changeLog));

  const afterProposeStatus = await founder.get('/api/founder/editor/status');
  const publicAfterPropose = await anon.get('/api/site-config');
  check('preview does NOT apply the change to the public site', headingOf(publicAfterPropose.data.config, 'home') === baseline, `${headingOf(publicAfterPropose.data.config, 'home')} vs ${baseline}`);
  check('preview does NOT create a draft version', (afterProposeStatus.data.draft && afterProposeStatus.data.draft.id) === (draft0 && draft0.id));
  check('preview does NOT move the LIVE version', (afterProposeStatus.data.live && afterProposeStatus.data.live.id) === (live0 && live0.id));
  check('preview is recorded in the audit trail', ((afterProposeStatus.data.events || []).length) > events0);

  /* ---------- 3. explicit approval writes a TEST draft only ---------- */
  const apply = await founder.post(`/api/founder/editor/proposals/${proposal.id}/apply`, {});
  check('explicit Founder approval applies the change', apply.status === 200, `status ${apply.status}`);
  const appliedDraft = apply.data && apply.data.draft;
  check('approval creates a new draft version', !!appliedDraft && appliedDraft.id !== (draft0 && draft0.id), JSON.stringify(appliedDraft && appliedDraft.id));
  check('approval alone does not publish to users', !!apply.data && apply.data.live && apply.data.live.id === (live0 && live0.id), JSON.stringify(apply.data && apply.data.live));

  const publicAfterApply = await anon.get('/api/site-config');
  check('public site still unchanged after approval (draft only)', headingOf(publicAfterApply.data.config, 'home') === baseline);

  const preview = await founder.get(`/api/site-config?version=${appliedDraft.id}`);
  check('Founder can preview the unpublished draft', preview.status === 200 && headingOf(preview.data.config, 'home') === NEW_HEADING, `status ${preview.status}`);
  check('draft preview is marked as a preview', preview.data && preview.data.preview === true);

  const statusAfterApply = await founder.get('/api/founder/editor/status');
  check('approval is recorded in the audit trail', ((statusAfterApply.data.events || []).length) > ((afterProposeStatus.data.events || []).length));
  check('audit trail names the acting Founder', JSON.stringify(statusAfterApply.data.events || []).includes(founderId));

  /* ---------- 4. duplicate submission does not duplicate versions ---------- */
  const versionsBeforeDup = await founder.get('/api/founder/editor/versions');
  const dup = await founder.post(`/api/founder/editor/proposals/${proposal.id}/apply`, {});
  const versionsAfterDup = await founder.get('/api/founder/editor/versions');
  check('re-applying an approved proposal is rejected or idempotent', [200, 400, 409].includes(dup.status), `status ${dup.status}`);
  check('re-applying does not create a second version', (versionsAfterDup.data.versions || []).length === (versionsBeforeDup.data.versions || []).length, `${(versionsBeforeDup.data.versions || []).length} -> ${(versionsAfterDup.data.versions || []).length}`);

  /* ---------- 5. publish, then roll back ---------- */
  const publish = await founder.post(`/api/founder/editor/versions/${appliedDraft.id}/publish`, {});
  check('Founder can publish the approved draft', publish.status === 200, `status ${publish.status}`);
  const publicPublished = await anon.get('/api/site-config');
  check('published change is visible on the public site', headingOf(publicPublished.data.config, 'home') === NEW_HEADING, headingOf(publicPublished.data.config, 'home'));

  const restore = await founder.post(`/api/founder/editor/versions/${live0.id}/restore`, { publish: true });
  check('Founder can roll back to the previous version', restore.status === 200, `status ${restore.status}`);
  const publicRestored = await anon.get('/api/site-config');
  check('rollback restores the original value', headingOf(publicRestored.data.config, 'home') === baseline, `${headingOf(publicRestored.data.config, 'home')} vs ${baseline}`);

  const versionsAfter = await founder.get('/api/founder/editor/versions');
  check('rollback keeps history instead of deleting versions', (versionsAfter.data.versions || []).length > versionCount0, `${versionCount0} -> ${(versionsAfter.data.versions || []).length}`);

  /* ---------- 6. authorization is enforced by the server ---------- */
  const anonStatus = await anon.get('/api/founder/editor/status');
  check('anonymous callers are rejected', anonStatus.status === 401, `status ${anonStatus.status}`);

  const memberStatus = await member.get('/api/founder/editor/status');
  check('ordinary members cannot open the Editor', memberStatus.status === 403, `status ${memberStatus.status}`);

  const memberPropose = await member.post('/api/founder/editor/propose', {
    summary: 'unauthorized', changes: [{ op: 'set_text', page: 'home', field: 'heading', value: 'hacked' }],
  });
  check('ordinary members cannot create proposals', memberPropose.status === 403, `status ${memberPropose.status}`);

  const memberApply = await member.post(`/api/founder/editor/proposals/${proposal.id}/apply`, {});
  check('ordinary members cannot approve changes', memberApply.status === 403, `status ${memberApply.status}`);

  const memberVersions = await member.get('/api/founder/editor/versions');
  check('ordinary members cannot list versions', memberVersions.status === 403, `status ${memberVersions.status}`);

  const memberEvents = await member.get('/api/founder/editor/events');
  check('ordinary members cannot read the editor audit trail', memberEvents.status === 403, `status ${memberEvents.status}`);

  const memberPreview = await member.get(`/api/site-config?version=${appliedDraft.id}`);
  check('ordinary members cannot preview unpublished drafts', memberPreview.status === 403, `status ${memberPreview.status}`);

  const memberPublish = await member.post(`/api/founder/editor/versions/${appliedDraft.id}/publish`, {});
  check('ordinary members cannot publish versions', memberPublish.status === 403, `status ${memberPublish.status}`);

  const memberRestore = await member.post(`/api/founder/editor/versions/${live0.id}/restore`, { publish: true });
  check('ordinary members cannot roll back versions', memberRestore.status === 403, `status ${memberRestore.status}`);

  const adminStatus = await admin.get('/api/founder/editor/status');
  check('a limited administrator does NOT receive Founder authority', adminStatus.status === 403, `status ${adminStatus.status}`);

  const spoofStatus = await spoof.get('/api/founder/editor/status');
  check('a typed Founder name does not grant Founder authority', spoofStatus.status === 403, `status ${spoofStatus.status}`);

  const publicStill = await anon.get('/api/site-config');
  check('rejected attempts left the public site untouched', headingOf(publicStill.data.config, 'home') === baseline, headingOf(publicStill.data.config, 'home'));

  /* ---------- 7. invalid edits are refused ---------- */
  const badOp = await founder.post('/api/founder/editor/propose', { changes: [{ op: 'drop_table', page: 'home' }] });
  check('unknown edit operations are rejected', badOp.status === 400, `status ${badOp.status}`);

  const badPage = await founder.post('/api/founder/editor/propose', {
    changes: [{ op: 'set_text', page: 'no-such-page', field: 'heading', value: 'x' }],
  });
  check('unknown pages are rejected', badPage.status === 400, `status ${badPage.status}`);

  /* ---------- 8. existing Founder features still work ---------- */
  const dash = await founder.get('/api/founder/dashboard');
  check('Founder Dashboard still loads for the Founder', dash.status === 200, `status ${dash.status}`);
  const dashMember = await member.get('/api/founder/dashboard');
  check('Founder Dashboard still rejects ordinary members', dashMember.status === 403, `status ${dashMember.status}`);

  const backups = await founder.get('/api/founder/backups');
  check('Stage A backup endpoint still responds', backups.status === 200, `status ${backups.status}`);

  console.log(`\nStage C Founder Editor: ${passed}/${passed + failures.length} checks passed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const failure of failures) console.log(` - ${failure}`);
    shutdown(1);
  }
  shutdown(0);
}

main().catch((err) => {
  console.error(err);
  console.error(serverLog.slice(-2000));
  shutdown(1);
});
