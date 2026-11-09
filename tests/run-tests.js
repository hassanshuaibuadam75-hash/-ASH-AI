// #ash Mesh — end-to-end API test suite.
//
// Boots the REAL server on an isolated temporary database, then drives it over HTTP
// exactly as the browser client does (session cookies + CSRF header). Nothing is mocked:
// every assertion below is a real database-backed request.
//
//   npm test
//
// Exit code 0 = every check passed.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 4599);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ash-mesh-test-'));

const FOUNDER_EMAIL = 'founder@ashmesh.test';
const results = [];
let failures = 0;

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

  async request(method, endpoint, body, { csrf = true } = {}) {
    const headers = {};
    if (this.cookies.size) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrf && this.csrf && !['GET', 'HEAD'].includes(method)) headers['x-csrf-token'] = this.csrf;
    const res = await fetch(BASE + endpoint, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.absorb(res);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text };
  }

  get(p, o) { return this.request('GET', p, undefined, o); }
  post(p, b, o) { return this.request('POST', p, b, o); }
  patch(p, b, o) { return this.request('PATCH', p, b, o); }
  del(p, o) { return this.request('DELETE', p, undefined, o); }
}

/* ------------------------------ server boot ------------------------------- */

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR,
    DB_PATH: path.join(DATA_DIR, 'test.db'),
    FORCE_INSECURE_COOKIES: '1',
    FOUNDER_EMAIL,
    GROQ_API_KEY: '',
    PAYSTACK_SECRET_KEY: '',
    RESEND_API_KEY: '',
    NODE_ENV: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });

async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early (${server.exitCode})\n${serverLog}`);
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become ready\n${serverLog}`);
}

function shutdown() {
  try { server.kill('SIGTERM'); } catch { /* already gone */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* --------------------------------- suite ---------------------------------- */

async function run() {
  await waitForServer();
  console.log(`\n#ash Mesh — API end-to-end suite\nserver: ${BASE}  data: ${DATA_DIR}\n`);

  const anon = new Client('anon');
  const founder = new Client('founder');
  const member = new Client('member');

  /* ---- health ---- */
  const health = await anon.get('/api/health');
  check('health endpoint reports ok', health.status === 200 && health.body?.status === 'ok', `status=${health.status}`);

  /* ---- registration ---- */
  const reg = await founder.post('/api/auth/register', {
    email: FOUNDER_EMAIL,
    username: 'founder',
    password: 'FounderPass123',
    fullName: 'Hassan Shuaibu Adam',
  });
  check('founder registers', reg.status === 201 && reg.body?.user?.id, `status=${reg.status} ${reg.text.slice(0, 200)}`);
  check('founder account carries founder authority', reg.body?.user?.isFounder === true, JSON.stringify(reg.body?.user?.isFounder));
  check('registration issues a CSRF token', !!founder.csrf, 'no ash_csrf cookie');

  const founderId = reg.body?.user?.id;

  const reg2 = await member.post('/api/auth/register', {
    email: 'member@ashmesh.test',
    username: 'member',
    password: 'MemberPass123',
    fullName: 'Member Tester',
  });
  check('second user registers', reg2.status === 201 && reg2.body?.user?.id, `status=${reg2.status}`);
  const memberId = reg2.body?.user?.id;

  const dupe = await anon.post('/api/auth/register', {
    email: FOUNDER_EMAIL,
    username: 'someoneelse',
    password: 'AnotherPass123',
    fullName: 'Duplicate Person',
  });
  check('duplicate email is rejected', dupe.status === 409, `status=${dupe.status}`);

  const weak = await anon.post('/api/auth/register', {
    email: 'weak@ashmesh.test',
    username: 'weakling',
    password: 'short',
    fullName: 'Weak Password',
  });
  check('weak password is rejected with field errors', weak.status === 400 && weak.body?.errors?.password, `status=${weak.status}`);

  /* ---- session + CSRF enforcement ---- */
  const me = await member.get('/api/auth/me');
  check('session returns the signed-in user', me.status === 200 && me.body?.user?.username === 'member', `status=${me.status}`);

  const noCsrf = await member.post('/api/posts', { body: 'should not be stored' }, { csrf: false });
  check('state-changing request without CSRF token is refused', noCsrf.status === 403 && noCsrf.body?.error === 'csrf_failed', `status=${noCsrf.status} ${noCsrf.text.slice(0, 120)}`);

  /* ---- posts, likes, comments ---- */
  const created = await member.post('/api/posts', { body: 'First real post from the test suite.', audience: 'public' });
  check('member publishes a post', created.status === 201 && created.body?.post?.id, `status=${created.status} ${created.text.slice(0, 160)}`);
  const postId = created.body?.post?.id;

  const feed = await founder.get('/api/feed?limit=50');
  const feedPosts = feed.body?.posts || [];
  check('public post appears in another user feed', feedPosts.some((p) => p.id === postId), `feed size=${feedPosts.length}`);

  const like = await founder.post(`/api/posts/${postId}/like`);
  check('liking a post succeeds', like.status === 200, `status=${like.status}`);

  const afterLike = await founder.get(`/api/posts/${postId}`);
  const likedPost = afterLike.body?.post;
  check('like is persisted for the viewer', likedPost?.likedByMe === true && likedPost?.counts?.likes === 1, JSON.stringify(likedPost?.counts));

  const unlike = await founder.post(`/api/posts/${postId}/like`);
  const afterUnlike = await founder.get(`/api/posts/${postId}`);
  check('liking again removes the like (toggle)', unlike.status === 200 && afterUnlike.body?.post?.counts?.likes === 0, JSON.stringify(afterUnlike.body?.post?.counts));

  const comment = await founder.post(`/api/posts/${postId}/comments`, { body: 'A real comment.' });
  check('comment is created', comment.status === 201, `status=${comment.status} ${comment.text.slice(0, 120)}`);

  const comments = await founder.get(`/api/posts/${postId}/comments`);
  const commentList = comments.body?.comments || [];
  check('comment is stored and returned', commentList.some((c) => (c.body || '').includes('A real comment')), `count=${commentList.length}`);

  const edited = await member.patch(`/api/posts/${postId}`, { body: 'Edited post body.' });
  check('author can edit their own post', edited.status === 200 && edited.body?.post?.body === 'Edited post body.', `status=${edited.status}`);

  const foreignEdit = await founder.patch(`/api/posts/${postId}`, { body: 'hijacked' });
  check('another user cannot edit the post', foreignEdit.status >= 403, `status=${foreignEdit.status}`);

  const unconfirmed = await member.del(`/api/posts/${postId}`);
  // The API refuses an unconfirmed delete with 428 "confirmation_required" (400 is also a refusal).
  check(
    'deleting without confirmation is refused',
    (unconfirmed.status === 428 || unconfirmed.status === 400) && !unconfirmed.body?.ok,
    `status=${unconfirmed.status} ${unconfirmed.text.slice(0, 120)}`
  );

  const stillThere = await member.get(`/api/posts/${postId}`);
  check('post survives the unconfirmed delete attempt', stillThere.status === 200, `status=${stillThere.status}`);

  const confirmed = await member.del(`/api/posts/${postId}?confirm=true`);
  check('confirmed delete succeeds', confirmed.status === 200, `status=${confirmed.status} ${confirmed.text.slice(0, 120)}`);

  const gone = await member.get(`/api/posts/${postId}`);
  check('deleted post is no longer readable', gone.status === 404, `status=${gone.status}`);

  /* ---- friendships ---- */
  const friendReq = await founder.post('/api/friends/request', { userId: memberId, username: 'member' });
  check('friend request is sent', friendReq.status === 201, `status=${friendReq.status} ${friendReq.text.slice(0, 160)}`);

  const incoming = await member.get('/api/friends/requests');
  const incomingList = incoming.body?.incoming || [];
  const request = incomingList.find((r) => r.user?.id === founderId);
  check('recipient sees the incoming request', !!request, `incoming=${incomingList.length}`);

  const accepted = await member.post(`/api/friends/${request?.requestId}/accept`);
  check('recipient accepts the request', accepted.status === 200, `status=${accepted.status} ${accepted.text.slice(0, 120)}`);

  const friendList = await member.get('/api/friends');
  check('accepted friend appears in the friends list', (friendList.body?.friends || []).some((f) => f.id === founderId), JSON.stringify((friendList.body?.friends || []).map((f) => f.username)));

  /* ---- end-to-end encrypted messaging ---- */
  const convo = await founder.post('/api/conversations', { userId: memberId });
  const conversationId = convo.body?.conversationId || convo.body?.conversation?.id;
  check('conversation is created', convo.status === 201 && !!conversationId, `status=${convo.status} ${convo.text.slice(0, 160)}`);

  const envelope = { v: 1, iv: 'aXYtY2lwaGVydGV4dA==', ct: 'Y2lwaGVydGV4dC1vbmx5', salt: 'c2FsdC1ieXRlcw==', pub: { kty: 'EC', crv: 'P-256' } };
  const sent = await founder.post(`/api/conversations/${conversationId}/messages`, {
    clientId: 'client-msg-1',
    envelope,
    kind: 'text',
    transport: 'internet',
  });
  check('encrypted message is accepted', sent.status === 201, `status=${sent.status} ${sent.text.slice(0, 200)}`);

  const inbox = await member.get(`/api/conversations/${conversationId}/messages`);
  const msgs = inbox.body?.messages || [];
  const received = msgs.find((m) => m.clientId === 'client-msg-1');
  check('recipient receives the message', !!received, `messages=${msgs.length}`);
  check('server stores ciphertext untouched (no plaintext, no key)', received?.envelope?.ct === envelope.ct && !JSON.stringify(received).includes('plaintext'), JSON.stringify(received?.envelope || null).slice(0, 160));

  const read = await member.post(`/api/conversations/${conversationId}/read`);
  check('read receipt is recorded', read.status === 200, `status=${read.status}`);

  const convoList = await member.get('/api/conversations');
  check('conversation appears in the list', (convoList.body?.conversations || []).some((c) => c.id === conversationId), `count=${(convoList.body?.conversations || []).length}`);

  const sync = await founder.post('/api/messages/sync', {
    messages: [{ clientId: 'queued-1', conversationId, envelope, kind: 'text', transport: 'queued' }],
  });
  check('offline queue sync endpoint accepts queued messages', sync.status === 200 || sync.status === 201, `status=${sync.status} ${sync.text.slice(0, 160)}`);

  const telemetry = await founder.post('/api/uar/telemetry', { transport: 'internet', battery: 15, available: ['internet', 'nearby'] });
  check('network telemetry is accepted', telemetry.status === 200 || telemetry.status === 201, `status=${telemetry.status}`);

  /* ---- privacy ---- */
  const privacy = await founder.patch('/api/users/me', { privacy: { profile: 'private' } });
  check('privacy setting is saved', privacy.status === 200, `status=${privacy.status} ${privacy.text.slice(0, 160)}`);

  const limited = await member.get('/api/users/founder');
  check('private profile is limited for non-friends', limited.status === 200 && (limited.body?.user?.privacyLimited === true || limited.body?.user?.bio === ''), `status=${limited.status} ${limited.text.slice(0, 200)}`);

  const selfView = await founder.get('/api/users/founder');
  check('owner still sees their full profile', selfView.status === 200 && selfView.body?.user?.privacy?.profile === 'private', `status=${selfView.status}`);

  /* ---- marketplace + commission ---- */
  const listing = await founder.post('/api/market/listings', {
    title: 'Test smartphone',
    description: 'Listed by the automated end-to-end suite.',
    category: 'phones',
    location: 'Kano',
    price: 250000,
  });
  check('listing is created', listing.status === 201 && listing.body?.listing?.id, `status=${listing.status} ${listing.text.slice(0, 200)}`);
  const listingId = listing.body?.listing?.id;
  check('listing stores price in minor units', listing.body?.listing?.priceMinor === 25000000, `priceMinor=${listing.body?.listing?.priceMinor}`);
  check('listing previews the 5% commission tier', listing.body?.listing?.commissionPreview?.rate === 0.05, JSON.stringify(listing.body?.listing?.commissionPreview));

  const order = await member.post(`/api/market/listings/${listingId}/orders`, { deliveryNote: 'Call on arrival.' });
  const orderBody = order.body?.order || order.body;
  check('buyer places an order', order.status === 201 && !!orderBody?.id, `status=${order.status} ${order.text.slice(0, 200)}`);
  check('order applies the approved 5% commission', orderBody?.commissionMinor === 1250000 && orderBody?.commissionRate === 0.05, JSON.stringify({ commission: orderBody?.commissionMinor, rate: orderBody?.commissionRate }));

  const pay = await member.post(`/api/market/orders/${orderBody?.id}/pay`, {});
  // With no payment provider key the endpoint must say so and must NOT report a successful charge.
  const payStatus = pay.body?.payment?.status;
  check(
    'payment without a provider key fails honestly (never simulated)',
    (pay.status >= 400 || payStatus === 'not_configured') &&
      payStatus !== 'success' &&
      pay.body?.payment?.paid !== true,
    `status=${pay.status} paymentStatus=${payStatus}`
  );

  const afterPay = await member.get(`/api/market/orders/${orderBody?.id}`);
  check(
    'order stays unpaid when no payment provider is configured',
    afterPay.body?.order?.status !== 'paid',
    `orderStatus=${afterPay.body?.order?.status}`
  );

  const fraud = await member.post('/api/market/fraud-report', { listingId, details: 'Automated suite fraud report check.' });
  check('fraud report is recorded', fraud.status === 201, `status=${fraud.status}`);

  /* ---- moderation ---- */
  const report = await member.post('/api/reports', { targetType: 'listing', targetId: listingId, reason: 'scam', details: 'Automated moderation check.' });
  check('content report is accepted', report.status === 201, `status=${report.status} ${report.text.slice(0, 160)}`);

  /* ---- #ash AI honesty ---- */
  const aiStatus = await founder.get('/api/ai/status');
  check('AI status reports unconfigured when no key is present', aiStatus.status === 200 && aiStatus.body?.configured === false, JSON.stringify(aiStatus.body).slice(0, 200));

  const aiCall = await founder.post('/api/ai/assist', { feature: 'writing', text: 'Hello' });
  check('AI request without a key returns a clear error instead of fake text', aiCall.status >= 400 && !!aiCall.body?.error, `status=${aiCall.status}`);

  /* ---- RBAC / founder authority ---- */
  const memberFounder = await member.get('/api/founder/dashboard');
  check('non-founder is denied the Founder Dashboard', memberFounder.status === 403, `status=${memberFounder.status}`);

  const memberAdmin = await member.get('/api/admin/overview');
  check('non-admin is denied administration', memberAdmin.status === 403, `status=${memberAdmin.status}`);

  const founderDash = await founder.get('/api/founder/dashboard');
  check('founder opens the Founder Dashboard', founderDash.status === 200, `status=${founderDash.status} ${founderDash.text.slice(0, 160)}`);
  check('dashboard reports real registered users', (founderDash.body?.people?.totalUsers ?? 0) >= 2, JSON.stringify(founderDash.body?.people).slice(0, 200));

  /* ---- blocking ---- */
  const block = await member.post(`/api/blocks/${founderId}`);
  check('user can block another user', block.status === 200 || block.status === 201, `status=${block.status}`);

  const blockedConvo = await founder.post('/api/conversations', { userId: memberId });
  check('blocked user cannot start a conversation', blockedConvo.status === 403, `status=${blockedConvo.status}`);

  const unblock = await member.del(`/api/blocks/${founderId}`);
  check('block can be removed', unblock.status === 200, `status=${unblock.status}`);

  /* ---- notifications ---- */
  const notes = await member.get('/api/notifications');
  const noteList = notes.body?.notifications || [];
  check('notifications were generated by real events', noteList.length > 0, `count=${noteList.length}`);

  /* ---- #ash Academy (real courses, lessons, enrolment, progress) ---- */
  const courseRes = await member.post('/api/academy/courses', {
    title: 'Offline Networking Basics',
    summary: 'How nearby mesh links work.',
    category: 'technology',
    level: 'beginner',
  });
  const courseId = courseRes.body?.course?.id;
  check('member publishes an Academy course', courseRes.status === 201 && !!courseId, `status=${courseRes.status} ${courseRes.text.slice(0, 160)}`);

  const lessonRes = await member.post(`/api/academy/courses/${courseId}/lessons`, {
    title: 'Routes and fallbacks',
    body: 'Internet first, then nearby links, then the offline queue.',
  });
  const lessonId = lessonRes.body?.course?.lessons?.[0]?.id;
  check('lesson is added to the course', lessonRes.status === 201 && !!lessonId, `status=${lessonRes.status}`);

  const courseDetail = await founder.get(`/api/academy/courses/${courseId}`);
  check('course detail returns its lessons', courseDetail.status === 200 && (courseDetail.body?.course?.lessons || []).length === 1, `status=${courseDetail.status}`);

  const enroll = await founder.post(`/api/academy/courses/${courseId}/enroll`, {});
  check('another member enrols in the course', enroll.status === 200, `status=${enroll.status}`);

  const progress = await founder.post(`/api/academy/courses/${courseId}/progress`, { lessonId, completed: true });
  const progressValue = progress.body?.course?.progress ?? progress.body?.course?.enrollment?.progress;
  check('lesson completion updates real progress', progress.status === 200 && progressValue === 100, `progress=${progressValue}`);

  const anonAcademy = await new Client('anon').get('/api/academy/courses');
  check('Academy requires authentication', anonAcademy.status === 401, `status=${anonAcademy.status}`);

  const academyBundle = await founder.get('/api/academy/offline-bundle');
  check('Academy offline bundle returns courses', academyBundle.status === 200 && (academyBundle.body?.courses || []).length > 0, `status=${academyBundle.status}`);

  /* ---- #ash Heritage ---- */
  const heritageRes = await member.post('/api/heritage', {
    title: 'Kano city walls',
    body: 'Ancient earthworks that ringed the old city.',
    category: 'history',
    region: 'Kano',
    country: 'Nigeria',
  });
  const heritageId = heritageRes.body?.entry?.id;
  check('member publishes a Heritage entry', heritageRes.status === 201 && !!heritageId, `status=${heritageRes.status} ${heritageRes.text.slice(0, 160)}`);

  const heritageList = await founder.get('/api/heritage');
  check('heritage entry is listed for other members', (heritageList.body?.entries || []).some((e) => e.id === heritageId), `status=${heritageList.status}`);

  const react = await founder.post(`/api/heritage/${heritageId}/react`, { kind: 'respect' });
  check('heritage entry accepts a reaction', react.status === 200 || react.status === 201, `status=${react.status}`);

  const heritageBundle = await founder.get('/api/heritage/offline-bundle');
  check('heritage offline bundle returns entries', heritageBundle.status === 200 && (heritageBundle.body?.entries || []).length > 0, `status=${heritageBundle.status}`);

  /* ---- offline synchronisation ---- */
  const founderPrivate = await founder.post('/api/posts', { body: 'Founder private note', audience: 'private' });
  const pull = await member.get('/api/sync/pull');
  const pulledPosts = pull.body?.posts || [];
  check('sync pull returns a cursor and the viewer', pull.status === 200 && !!pull.body?.cursor && !!pull.body?.user, `status=${pull.status}`);
  check('sync pull never exposes another user private post', !pulledPosts.some((p) => p.id === founderPrivate.body?.post?.id), `leaked=${pulledPosts.length}`);

  const offlineClientId = 'offline-post-1';
  const firstPush = await member.post('/api/sync/push', {
    operations: [{ clientId: offlineClientId, type: 'post', body: 'Written while offline.', audience: 'public' }],
  });
  const firstResult = firstPush.body?.results?.[0];
  check('offline post replays through sync push', firstPush.status === 200 && firstResult?.status === 'accepted' && !!firstResult?.id, JSON.stringify(firstResult));

  const secondPush = await member.post('/api/sync/push', {
    operations: [{ clientId: offlineClientId, type: 'post', body: 'Written while offline.', audience: 'public' }],
  });
  const secondResult = secondPush.body?.results?.[0];
  check('replaying the same offline post is idempotent', secondResult?.status === 'duplicate' && secondResult?.id === firstResult?.id, JSON.stringify(secondResult));

  const emptyPush = await member.post('/api/sync/push', {
    operations: [{ clientId: 'offline-empty-1', type: 'post', body: '   ' }],
  });
  check('empty offline post is rejected, not stored', emptyPush.body?.results?.[0]?.status === 'rejected', JSON.stringify(emptyPush.body?.results?.[0]));

  const likePush = await member.post('/api/sync/push', {
    operations: [{ clientId: 'offline-like-1', type: 'like', postId: firstResult?.id, liked: true }],
  });
  check('offline like replays idempotently', likePush.body?.results?.[0]?.status === 'accepted' && likePush.body?.results?.[0]?.likes === 1, JSON.stringify(likePush.body?.results?.[0]));

  const anonPush = await new Client('anon').post('/api/sync/push', { operations: [] });
  check('sync push requires authentication', anonPush.status === 401, `status=${anonPush.status}`);

  /* ---- logout ---- */
  const logout = await founder.post('/api/auth/logout', {});
  check('logout succeeds', logout.status === 200, `status=${logout.status}`);
  const afterLogout = await founder.get('/api/auth/me');
  check('session is cleared after logout', afterLogout.status === 200 && afterLogout.body?.user === null, JSON.stringify(afterLogout.body).slice(0, 120));
  const afterLogoutPost = await founder.post('/api/posts', { body: 'should be rejected' });
  check('signed-out user cannot publish', afterLogoutPost.status === 401, `status=${afterLogoutPost.status}`);

  /* ---- summary ---- */
  const total = results.length;
  const passed = total - failures;
  console.log(`\n${'-'.repeat(60)}\n${passed}/${total} checks passed${failures ? `, ${failures} FAILED` : ''}\n${'-'.repeat(60)}\n`);
  if (failures) {
    console.log('Failed checks:');
    for (const r of results.filter((r) => !r.ok)) console.log(` - ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
    console.log('\nServer log tail:\n' + serverLog.split('\n').slice(-25).join('\n'));
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
