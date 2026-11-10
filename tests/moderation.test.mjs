// #ash Mesh — moderation, official AI account and AI status privacy tests.
//
// Boots the REAL server on an isolated temporary database and drives it over HTTP with
// session cookies + CSRF, exactly like the browser client. Nothing is mocked.
//
// Covered here:
//   * AI status hides provider/model from ordinary members, keeps diagnostics for staff
//   * the official @ashai account exists, is flagged AI, and can publish when staff ask
//   * moderation bands: clear / review / quarantine, with the real thresholds
//   * quarantined posts are hidden from other people but visible to their author
//   * evidence (the original text) is preserved for the reviewer
//   * staff decisions restore content; nothing is deleted and no account is banned
//   * appeals are recorded once (duplicate prevention) and staff-only actions are refused
//
//   node tests/moderation.test.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT_MOD || 4610);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ash-mesh-mod-'));
const FOUNDER_EMAIL = 'founder.moderation@ashmesh.test';

const results = [];
let failures = 0;
let serverLog = '';

function check(name, condition, detail) {
  const ok = !!condition;
  if (!ok) failures += 1;
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ↳ ${detail}`}`);
  return ok;
}

/* ------------------------------- HTTP client ------------------------------ */

class Client {
  constructor(label) {
    this.label = label;
    this.cookies = new Map();
    this.csrf = null;
  }

  absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const raw of list) {
      const pair = raw.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '' || /Expires=Thu, 01 Jan 1970/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
      if (name === 'ash_csrf') this.csrf = value || null;
    }
  }

  async request(method, endpoint, body) {
    const headers = {};
    if (this.cookies.size) {
      headers.cookie = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(BASE + endpoint, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    this.absorb(res);
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { status: res.status, body: parsed, text };
  }

  get(e) { return this.request('GET', e); }
  post(e, b) { return this.request('POST', e, b === undefined ? {} : b); }
}

/* --------------------------------- booting -------------------------------- */

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR,
    DB_PATH: path.join(DATA_DIR, 'test.db'),
    FOUNDER_EMAIL,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });

function shutdown() {
  try { server.kill('SIGTERM'); } catch { /* ignore */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function waitForServer() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.status < 500) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const founder = new Client('founder');
const author = new Client('author');
const observer = new Client('observer');

const THREAT_TEXT = 'I will kill you and you should die tonight';
const BORDERLINE_TEXT = 'This is an original copy of a designer bag';
const CLEAN_TEXT = 'Sharing photos from the Kano tech meetup this weekend — great turnout.';

async function run() {
  if (!(await waitForServer())) throw new Error('server did not start');

  /* ------------------------------ accounts ------------------------------- */
  const fReg = await founder.post('/api/auth/register', {
    email: FOUNDER_EMAIL, username: 'foundermod', password: 'FounderPass123', fullName: 'Founder Mod',
  });
  check('founder account registers', fReg.status === 201 && fReg.body?.user?.id, `${fReg.status} ${fReg.text.slice(0, 160)}`);

  const aReg = await author.post('/api/auth/register', {
    email: 'author.moderation@ashmesh.test', username: 'authormod', password: 'AuthorPass123', fullName: 'Author Mod',
  });
  check('author account registers', aReg.status === 201 && aReg.body?.user?.id, `${aReg.status} ${aReg.text.slice(0, 160)}`);

  const oReg = await observer.post('/api/auth/register', {
    email: 'observer.moderation@ashmesh.test', username: 'observermod', password: 'ObserverPass123', fullName: 'Observer Mod',
  });
  check('observer account registers', oReg.status === 201 && oReg.body?.user?.id, `${oReg.status} ${oReg.text.slice(0, 160)}`);

  /* --------------------- AI status hides provider text -------------------- */
  const memberStatus = await author.get('/api/ai/status');
  check('member can read AI status', memberStatus.status === 200, `status=${memberStatus.status}`);
  check(
    'AI status exposes no provider name to members',
    memberStatus.body && !('provider' in memberStatus.body),
    JSON.stringify(memberStatus.body).slice(0, 200)
  );
  check(
    'AI status exposes no model name to members',
    memberStatus.body && !('model' in memberStatus.body),
    JSON.stringify(memberStatus.body).slice(0, 200)
  );
  check(
    'AI status gives members only an online flag',
    typeof memberStatus.body?.online === 'boolean' && memberStatus.body?.diagnostics === null,
    JSON.stringify(memberStatus.body).slice(0, 200)
  );

  const staffStatus = await founder.get('/api/ai/status');
  check(
    'staff still get internal diagnostics',
    staffStatus.status === 200 && !!staffStatus.body?.diagnostics?.model,
    JSON.stringify(staffStatus.body).slice(0, 200)
  );

  /* ------------------------ official AI account -------------------------- */
  const official = await author.get('/api/ai/official');
  const account = official.body?.account || official.body?.user || official.body;
  check('official AI account is served', official.status === 200, `status=${official.status}`);
  check('official AI account is @ashai', account?.username === 'ashai', JSON.stringify(account).slice(0, 200));
  check('official AI account is flagged as AI', account?.isAi === true, JSON.stringify(account).slice(0, 200));

  /* --------------------------- moderation bands -------------------------- */
  const clean = await author.post('/api/posts', { body: CLEAN_TEXT, audience: 'public' });
  check('clean post is created', clean.status === 201, `${clean.status} ${clean.text.slice(0, 160)}`);
  check('clean post is not flagged', clean.body?.moderation?.status === 'clear', JSON.stringify(clean.body?.moderation));

  const threat = await author.post('/api/posts', { body: THREAT_TEXT, audience: 'public' });
  const threatId = threat.body?.post?.id;
  check('abusive post is still created (never silently dropped)', threat.status === 201 && !!threatId, `${threat.status}`);
  check(
    'abusive post is quarantined by confidence threshold',
    threat.body?.moderation?.status === 'quarantine',
    JSON.stringify(threat.body?.moderation)
  );
  check('quarantine returns a review id', !!threat.body?.moderation?.reviewId, JSON.stringify(threat.body?.moderation));

  const borderline = await author.post('/api/posts', { body: BORDERLINE_TEXT, audience: 'public' });
  check(
    'borderline counterfeit wording goes to human review, not quarantine',
    borderline.body?.moderation?.status === 'review',
    JSON.stringify(borderline.body?.moderation)
  );

  /* --------------------------- feed visibility --------------------------- */
  const observerFeed = await observer.get('/api/feed?limit=30');
  const observerIds = (observerFeed.body?.posts || []).map((p) => p.id);
  check('observer feed loads', observerFeed.status === 200, `status=${observerFeed.status}`);
  check('quarantined post is hidden from other people', !observerIds.includes(threatId), `visible=${observerIds.length}`);
  check(
    'borderline post stays visible while queued for review',
    (observerFeed.body?.posts || []).some((p) => p.body === BORDERLINE_TEXT),
    'review band should not hide content'
  );

  const authorFeed = await author.get('/api/feed?limit=30');
  const ownThreat = (authorFeed.body?.posts || []).find((p) => p.id === threatId);
  check('author still sees their own quarantined post', !!ownThreat, 'author must be able to see and appeal it');
  check(
    'author sees the moderation state on their post',
    ownThreat?.moderationStatus === 'quarantined',
    JSON.stringify(ownThreat?.moderationStatus)
  );

  /* ------------------------- staff-only boundaries ----------------------- */
  const memberQueue = await author.get('/api/moderation/queue');
  check('members cannot read the review queue', memberQueue.status === 403, `status=${memberQueue.status}`);
  const memberDecide = await author.post(`/api/moderation/reviews/${threat.body?.moderation?.reviewId}/decide`, { action: 'approve' });
  check('members cannot decide a review', memberDecide.status === 403, `status=${memberDecide.status}`);
  const memberPublish = await author.post('/api/ai/official/publish', { category: 'announcement', body: 'Not allowed' });
  check('members cannot publish as the official account', memberPublish.status === 403, `status=${memberPublish.status}`);

  /* --------------------------- evidence preserved ------------------------ */
  const queue = await founder.get('/api/moderation/queue');
  check('staff can read the review queue', queue.status === 200, `status=${queue.status}`);
  const review = (queue.body?.reviews || []).find((r) => r.targetId === threatId);
  check('flagged post appears in the queue', !!review, JSON.stringify(queue.body?.reviews?.length));
  check('review keeps the original text as evidence', review?.contentSnapshot === THREAT_TEXT, JSON.stringify(review?.contentSnapshot));
  check('review records why it was flagged', (review?.reasons || []).length > 0, JSON.stringify(review?.reasons));
  check('queue reports the real thresholds', queue.body?.thresholds?.quarantine === 0.85, JSON.stringify(queue.body?.thresholds));

  /* ---------------------------- human decision --------------------------- */
  const decide = await founder.post(`/api/moderation/reviews/${review.id}/decide`, {
    action: 'approve', note: 'Context reviewed by moderator',
  });
  check('staff can restore content', decide.status === 200 && decide.body?.review?.status === 'approved', `${decide.status} ${decide.text.slice(0, 160)}`);

  const observerAfter = await observer.get('/api/feed?limit=30');
  check(
    'restored post is visible to other people again',
    (observerAfter.body?.posts || []).some((p) => p.id === threatId),
    'approve must publish it back'
  );

  /* -------------------------------- appeals ------------------------------ */
  const appeal = await author.post(`/api/moderation/reviews/${review.id}/appeal`, { message: 'This was a quote from a film, please re-check.' });
  check('author can appeal a decision', appeal.status === 201 && !!appeal.body?.appeal, `${appeal.status} ${appeal.text.slice(0, 160)}`);
  const dupe = await author.post(`/api/moderation/reviews/${review.id}/appeal`, { message: 'Sending the same appeal again.' });
  check('duplicate appeals are prevented', dupe.status === 200 && dupe.body?.duplicate === true, `${dupe.status} ${dupe.text.slice(0, 160)}`);

  const otherAppeal = await observer.post(`/api/moderation/reviews/${review.id}/appeal`, { message: 'Not my content.' });
  check('only the author can appeal their content', otherAppeal.status === 403, `status=${otherAppeal.status}`);

  /* --------------------------- no automatic bans ------------------------- */
  const afterFlag = await author.post('/api/posts', { body: 'A normal follow-up post from the same account.', audience: 'public' });
  check('flagged author is not banned and can post again', afterFlag.status === 201, `status=${afterFlag.status}`);
  const stillLoggedIn = await author.get('/api/auth/me');
  check('flagged author session is intact', stillLoggedIn.status === 200 && !!stillLoggedIn.body?.user?.id, `${stillLoggedIn.status}`);

  /* ----------------------- official AI publishing ------------------------ */
  const publish = await founder.post('/api/ai/official/publish', {
    category: 'heritage',
    body: 'Kano’s Kurmi Market has traded for centuries — a reminder of the city’s long history of craft and commerce.',
  });
  check('staff can publish as #ash AI', publish.status === 201 && publish.body?.published === true, `${publish.status} ${publish.text.slice(0, 160)}`);

  const feedWithAi = await observer.get('/api/feed?limit=30');
  const aiPost = (feedWithAi.body?.posts || []).find((p) => p.author?.username === 'ashai');
  check('official AI post appears in the feed', !!aiPost, 'expected an @ashai post in the feed');
  check('official AI post is labelled AI-generated', aiPost?.aiGenerated === true, JSON.stringify(aiPost?.aiGenerated));
  check('official AI author is marked as AI', aiPost?.author?.isAi === true, JSON.stringify(aiPost?.author?.isAi));

  const badPublish = await founder.post('/api/ai/official/publish', { category: 'announcement', body: '' });
  check('empty AI publication is rejected', badPublish.status === 400, `status=${badPublish.status}`);

  /* ---------------------------- founder view ----------------------------- */
  const stats = await founder.get('/api/moderation/stats');
  check('moderation stats are available to the Founder dashboard', stats.status === 200, `status=${stats.status}`);
  check(
    'stats report real review counts',
    typeof (stats.body?.stats?.queue ?? stats.body?.queue) === 'number',
    JSON.stringify(stats.body).slice(0, 200)
  );

  /* ------------------------------- summary ------------------------------- */
  const total = results.length;
  const passed = total - failures;
  console.log(`\n${'-'.repeat(60)}\n${passed}/${total} moderation & AI checks passed${failures ? `, ${failures} FAILED` : ''}\n${'-'.repeat(60)}\n`);
  if (failures) {
    console.log('Failed checks:');
    for (const r of results.filter((r) => !r.ok)) console.log(` - ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
    console.log('\nServer log tail:\n' + serverLog.split('\n').slice(-30).join('\n'));
  }
  return failures === 0;
}

let ok = false;
try {
  ok = await run();
} catch (err) {
  console.error('\nSuite crashed:', err?.message || err);
  if (serverLog) console.error('\nServer log:\n' + serverLog.split('\n').slice(-30).join('\n'));
  ok = false;
} finally {
  shutdown();
}
process.exit(ok ? 0 : 1);
