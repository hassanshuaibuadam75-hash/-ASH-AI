// #ash Mesh — Stage A: backup and restore drill.
//
// Boots the REAL server twice against isolated temporary databases and proves the whole
// durability path end to end:
//
//   seed real records -> snapshot -> verify -> download -> export archive
//   -> simulate data loss (delete a post, register a new account)
//   -> restore -> the deleted post, comment, like, friendship and message come back
//   -> the account created after the snapshot is gone
//   -> restore again from the downloaded file, the way an operator recovers off-platform
//   -> retention prunes old snapshots, path traversal and corrupt files are refused
//   -> a second instance proves the scheduler writes snapshots with no user action
//
//   node tests/backup.test.mjs
//
// Nothing here touches the LIVE deployment, the real data directory or the Supabase projects.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const FOUNDER_EMAIL = 'founder@ashmesh.test';
const FOUNDER_PASSWORD = 'FounderPass123';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

const results = [];
let failures = 0;

function check(name, condition, detail) {
  const ok = !!condition;
  if (!ok) failures += 1;
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ↳ ${detail}`}`);
  return ok;
}

/* ------------------------------- server boot ------------------------------ */

async function boot({ port, dataDir, env = {} }) {
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      DB_PATH: path.join(dataDir, 'ash-mesh.db'),
      FORCE_INSECURE_COOKIES: '1',
      FOUNDER_EMAIL,
      FOUNDER_PASSWORD,
      GROQ_API_KEY: '',
      PAYSTACK_SECRET_KEY: '',
      RESEND_API_KEY: '',
      NODE_ENV: 'test',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${log}`);
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) { ready = true; break; }
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  if (!ready) throw new Error(`server did not become ready\n${log}`);

  return {
    base,
    log: () => log,
    stop() {
      return new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', resolve);
        child.kill('SIGTERM');
        const force = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
        force.unref();
      });
    },
  };
}

/* ------------------------------- HTTP client ------------------------------ */

class Client {
  constructor(base, label) {
    this.base = base;
    this.label = label;
    this.cookies = new Map();
    this.csrf = null;
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
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

  async req(method, endpoint, body) {
    const headers = {};
    if (this.cookies.size) headers.cookie = this.cookieHeader();
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.csrf && !['GET', 'HEAD'].includes(method)) headers['x-csrf-token'] = this.csrf;
    const res = await fetch(this.base + endpoint, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.absorb(res);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json, text };
  }

  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b); }
  del(p) { return this.req('DELETE', p); }

  async upload(endpoint, buffer, filename, type = 'application/octet-stream') {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type }), filename);
    const headers = { cookie: this.cookieHeader() };
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    const res = await fetch(this.base + endpoint, { method: 'POST', headers, body: form });
    this.absorb(res);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json, text };
  }

  async bytes(endpoint) {
    const res = await fetch(this.base + endpoint, { headers: this.cookies.size ? { cookie: this.cookieHeader() } : {} });
    return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
  }
}

/* ------------------------------ zip inspection ----------------------------- */
// The export is written with stored (uncompressed) entries; this reads the real central
// directory rather than trusting a filename inside the bytes.

function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory header');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, entry) {
  const local = entry.localOff;
  const nameLen = buf.readUInt16LE(local + 26);
  const extraLen = buf.readUInt16LE(local + 28);
  const start = local + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compSize);
  return entry.method === 0 ? data : zlib.inflateRawSync(data);
}

/* --------------------------------- drill ---------------------------------- */

async function main() {
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'ash-mesh-backup-drill-'));
  const backupsDir = path.join(dir1, 'backups');
  const uploadsDir = path.join(dir1, 'uploads');

  const phase1 = await boot({
    port: Number(process.env.BACKUP_TEST_PORT || 4601),
    dataDir: dir1,
    env: {
      BACKUP_SCHEDULER: 'off', // the scheduled path is proven separately below
      BACKUP_RETENTION: '2',
      BACKUP_INTERVAL_MINUTES: '1440',
    },
  });
  const BASE = phase1.base;

  const anon = new Client(BASE, 'anon');
  const founder = new Client(BASE, 'founder');
  const member = new Client(BASE, 'member');
  const friend = new Client(BASE, 'friend');

  /* ---- founder session and policy ---- */

  const login = await founder.post('/api/auth/login', { email: FOUNDER_EMAIL, password: FOUNDER_PASSWORD });
  check('founder signs in with the server-configured credentials', login.status === 200 && login.body?.user?.id, `status=${login.status} ${login.text.slice(0, 160)}`);

  const status0 = await founder.get('/api/founder/backups');
  const policy = status0.body?.policy || {};
  check('backup status reports the retention policy and directory', status0.status === 200 && policy.retention === 2 && policy.intervalMinutes === 1440 && typeof policy.directory === 'string', `status=${status0.status} ${status0.text.slice(0, 200)}`);
  check('backup status states plainly that container storage is not durable', policy.durableStorage === false && /persistent disk/i.test(status0.text), `durableStorage=${policy.durableStorage}`);

  /* ---- authorization ---- */

  const anonList = await anon.get('/api/founder/backups');
  check('anonymous access to backups is refused', anonList.status === 401, `status=${anonList.status}`);

  const regMember = await member.post('/api/auth/register', { email: 'member@ashmesh.test', username: 'member', password: 'MemberPass123', fullName: 'Member Tester' });
  const memberId = regMember.body?.user?.id;
  check('member account is created', regMember.status === 201 && !!memberId, `status=${regMember.status}`);

  const regFriend = await friend.post('/api/auth/register', { email: 'friend@ashmesh.test', username: 'friend', password: 'FriendPass123', fullName: 'Friend Tester' });
  const friendId = regFriend.body?.user?.id;
  check('second account is created', regFriend.status === 201 && !!friendId, `status=${regFriend.status}`);

  const memberList = await member.get('/api/founder/backups');
  check('non-founder cannot list backups', memberList.status === 403, `status=${memberList.status}`);
  const memberCreate = await member.post('/api/founder/backups', {});
  check('non-founder cannot create a backup', memberCreate.status === 403, `status=${memberCreate.status}`);
  const memberExport = await member.get('/api/founder/export');
  check('non-founder cannot export the database', memberExport.status === 403, `status=${memberExport.status}`);
  const memberRestore = await member.post('/api/founder/backups/ash-mesh-20260101-000000-abcdef.db/restore', {});
  check('non-founder cannot restore a backup', memberRestore.status === 403, `status=${memberRestore.status}`);

  /* ---- seed real records ---- */

  const postRes = await member.post('/api/posts', { body: 'Stage A drill post — must survive a restore.', audience: 'public' });
  const postId = postRes.body?.post?.id;
  check('member publishes a post', postRes.status === 201 && !!postId, `status=${postRes.status} ${postRes.text.slice(0, 160)}`);

  const commentRes = await founder.post(`/api/posts/${postId}/comments`, { body: 'Drill comment that must survive.' });
  check('comment is stored', commentRes.status === 201, `status=${commentRes.status} ${commentRes.text.slice(0, 160)}`);

  const likeRes = await founder.post(`/api/posts/${postId}/like`, {});
  check('like is stored', likeRes.status === 200, `status=${likeRes.status}`);

  const reqRes = await member.post('/api/friends/request', { userId: friendId });
  const incoming = await friend.get('/api/friends/requests');
  const requestId = (incoming.body?.requests || [])[0]?.id;
  const accept = await friend.post(`/api/friends/${requestId}/accept`, {});
  check('friendship is accepted', reqRes.status === 201 && accept.status === 200 && !!requestId, `request=${reqRes.status} accept=${accept.status}`);

  const convo = await member.post('/api/conversations', { userId: friendId });
  const conversationId = convo.body?.conversationId || convo.body?.conversation?.id;
  const envelope = { v: 1, iv: 'aXYtY2lwaGVydGV4dA==', ct: 'ZHJpbGwtY2lwaGVydGV4dA==', salt: 'c2FsdC1ieXRlcw==', pub: { kty: 'EC', crv: 'P-256' } };
  const msg = await member.post(`/api/conversations/${conversationId}/messages`, { envelope, kind: 'text', clientId: 'drill-msg-1', transport: 'internet' });
  check('encrypted message is stored', convo.status === 201 && msg.status === 201, `convo=${convo.status} msg=${msg.status}`);

  const avatar = await member.upload('/api/users/me/avatar', PNG, 'avatar.png', 'image/png');
  check('member uploads a profile photo', avatar.status === 200 || avatar.status === 201, `status=${avatar.status} ${avatar.text.slice(0, 160)}`);
  check('the uploaded file is on disk outside the database', fs.existsSync(uploadsDir) && fs.readdirSync(uploadsDir).length >= 1, 'uploads directory is empty');

  /* ---- snapshot, verify, download, export ---- */

  const created = await founder.post('/api/founder/backups', {});
  const meta = created.body?.backup;
  check('founder creates a snapshot', created.status === 201 && /^ash-mesh-\d{8}-\d{6}-[0-9a-f]{6}\.db$/.test(meta?.name || ''), `status=${created.status} ${created.text.slice(0, 200)}`);
  check('snapshot passed its own integrity check', meta?.integrity === 'ok', `integrity=${meta?.integrity}`);
  check('snapshot records a checksum, size and row counts', /^[0-9a-f]{64}$/.test(meta?.sha256 || '') && meta?.sizeBytes > 0 && meta?.rows > 0 && (meta?.counts?.users ?? 0) >= 3, JSON.stringify(meta?.counts || {}).slice(0, 200));
  check('snapshot file and its checksum sidecar exist on disk', fs.existsSync(path.join(backupsDir, meta?.name || 'missing')) && fs.existsSync(path.join(backupsDir, `${meta?.name}.json`)), 'sidecar missing');

  const verified = await founder.post(`/api/founder/backups/${meta.name}/verify`, {});
  check('founder re-verifies the snapshot against its recorded checksum', verified.status === 200 && verified.text.includes(meta.sha256), `status=${verified.status} ${verified.text.slice(0, 200)}`);

  const download = await founder.bytes(`/api/founder/backups/${meta.name}/download`);
  const downloadedSha = crypto.createHash('sha256').update(download.buf).digest('hex');
  check('downloaded snapshot is byte-identical to the verified checksum', download.status === 200 && download.buf.subarray(0, 15).toString('latin1') === 'SQLite format 3' && downloadedSha === meta.sha256, `status=${download.status} sha=${downloadedSha.slice(0, 12)}`);

  const archive = await founder.bytes('/api/founder/export');
  const entries = archive.status === 200 ? zipEntries(archive.buf) : [];
  const names = entries.map((e) => e.name);
  check('founder exports a zip archive', archive.status === 200 && archive.buf.subarray(0, 2).toString() === 'PK', `status=${archive.status}`);
  check('archive contains the manifest, the database and the uploaded files', names.includes('manifest.json') && names.some((n) => n.startsWith('database/')) && names.some((n) => n.startsWith('uploads/')), names.slice(0, 8).join(', '));

  let manifest = null;
  try {
    const entry = entries.find((e) => e.name === 'manifest.json');
    manifest = entry ? JSON.parse(readEntry(archive.buf, entry).toString('utf8')) : null;
  } catch (err) {
    manifest = null;
  }
  check('archive manifest carries the snapshot checksum and recovery steps', /^[0-9a-f]{64}$/.test(manifest?.database?.sha256 || '') && Array.isArray(manifest?.restore) && manifest.restore.length > 0, JSON.stringify(manifest || {}).slice(0, 200));

  /* ---- simulate data loss after the snapshot ---- */

  const deleted = await member.del(`/api/posts/${postId}`);
  check('post is deleted to simulate data loss', deleted.status === 200, `status=${deleted.status}`);

  const late = new Client(BASE, 'late');
  const lateReg = await late.post('/api/auth/register', { email: 'late@ashmesh.test', username: 'late', password: 'LatePass123', fullName: 'Late Account' });
  check('an account created after the snapshot exists', lateReg.status === 201, `status=${lateReg.status}`);

  const afterLoss = await founder.get('/api/feed?limit=50');
  check('the deleted post is genuinely gone before restoring', !(afterLoss.body?.posts || []).some((p) => p.id === postId), 'post still present');

  /* ---- restore from the stored snapshot ---- */

  const restore = await founder.post(`/api/founder/backups/${meta.name}/restore`, {});
  const info = restore.body?.restore || {};
  check('founder restores the snapshot', restore.status === 200 && info.restoredFrom === meta.name, `status=${restore.status} ${restore.text.slice(0, 200)}`);
  check('restore reports a healthy database with no foreign-key violations', info.integrity === 'ok' && info.foreignKeyViolations === 0, `integrity=${info.integrity} fk=${info.foreignKeyViolations}`);
  check('restore takes a pre-restore safety snapshot first', !!info.safetyBackup && fs.existsSync(path.join(backupsDir, info.safetyBackup)), `safety=${info.safetyBackup}`);

  const statusAfter = await founder.get('/api/founder/backups');
  check('founder remains signed in after the restore', statusAfter.status === 200, `status=${statusAfter.status}`);

  /* ---- restored data integrity ---- */

  const feedAfter = await founder.get('/api/feed?limit=50');
  check('restored post is back in the feed', (feedAfter.body?.posts || []).some((p) => p.id === postId), 'post missing');

  const commentsAfter = await founder.get(`/api/posts/${postId}/comments`);
  check('restored comments are intact', (commentsAfter.body?.comments || []).length === 1, `count=${(commentsAfter.body?.comments || []).length}`);

  const likesAfter = await founder.get(`/api/posts/${postId}/likes`);
  const likesBody = likesAfter.body || {};
  const likeCount = Array.isArray(likesBody.likes) ? likesBody.likes.length : Array.isArray(likesBody) ? likesBody.length : likesBody.count;
  check('restored like is intact', likeCount === 1, `count=${likeCount}`);

  const friendsAfter = await member.get('/api/friends');
  check('restored friendship is intact', (friendsAfter.body?.friends || []).some((f) => f.id === friendId), 'friend missing');

  const messagesAfter = await member.get(`/api/conversations/${conversationId}/messages`);
  check('restored conversation messages are intact', (messagesAfter.body?.messages || []).length === 1, `count=${(messagesAfter.body?.messages || []).length}`);

  const memberLogin = await member.post('/api/auth/login', { email: 'member@ashmesh.test', password: 'MemberPass123' });
  check('restored account can still sign in with its original profile', memberLogin.status === 200 && memberLogin.body?.user?.fullName === 'Member Tester', `status=${memberLogin.status}`);

  const lateLogin = await new Client(BASE, 'late-again').post('/api/auth/login', { email: 'late@ashmesh.test', password: 'LatePass123' });
  check('the account created after the snapshot is gone after restore', lateLogin.status === 401, `status=${lateLogin.status}`);

  const compared = ['users', 'posts', 'comments', 'conversations'].every((t) => (info.tables?.[t] ?? -1) === (meta?.counts?.[t] ?? -2));
  check('restored row counts match the snapshot exactly', compared, `restored=${JSON.stringify(info.tables || {}).slice(0, 200)} snapshot=${JSON.stringify(meta?.counts || {}).slice(0, 200)}`);

  /* ---- retention ---- */

  const createdNames = [];
  for (let i = 0; i < 3; i += 1) {
    const res = await founder.post('/api/founder/backups', {});
    if (res.body?.backup?.name) createdNames.push(res.body.backup.name);
  }
  const listAfter = await founder.get('/api/founder/backups');
  check('retention keeps only the configured number of snapshots', (listAfter.body?.backups || []).length === 2, `count=${(listAfter.body?.backups || []).length}`);
  check('pruned snapshots are removed from disk', createdNames.slice(0, createdNames.length - 2).every((n) => !fs.existsSync(path.join(backupsDir, n))), `names=${createdNames.length}`);

  /* ---- hostile input ---- */

  const traversal = await founder.post('/api/founder/backups/..%2F..%2Fetc%2Fpasswd/restore', {});
  check('restore refuses a name that escapes the backup directory', traversal.status === 400 || traversal.status === 404, `status=${traversal.status}`);
  const traversalGet = await founder.get('/api/founder/backups/..%2Fsecret.db/download');
  check('download refuses a name that escapes the backup directory', traversalGet.status === 400 || traversalGet.status === 404, `status=${traversalGet.status}`);

  const junk = await founder.upload('/api/founder/backups/restore-upload', Buffer.from('this is not a database'), 'junk.db');
  check('restore rejects a file that is not a SQLite database', junk.status === 400, `status=${junk.status} ${junk.text.slice(0, 160)}`);

  const broken = Buffer.concat([Buffer.from('SQLite format 3\u0000', 'latin1'), Buffer.alloc(4096, 7)]);
  const brokenRes = await founder.upload('/api/founder/backups/restore-upload', broken, 'broken.db');
  check('restore rejects a corrupt SQLite file', brokenRes.status === 400, `status=${brokenRes.status} ${brokenRes.text.slice(0, 160)}`);

  /* ---- off-platform recovery: restore the downloaded file ---- */

  const deletedAgain = await member.del(`/api/posts/${postId}`);
  check('post is deleted again for the off-platform recovery test', deletedAgain.status === 200, `status=${deletedAgain.status}`);
  await new Client(BASE, 'late2').post('/api/auth/register', { email: 'late2@ashmesh.test', username: 'late2', password: 'Late2Pass123', fullName: 'Late Two' });

  const uploadRestore = await founder.upload('/api/founder/backups/restore-upload', download.buf, meta.name);
  const uploadInfo = uploadRestore.body?.restore || {};
  check('founder restores from an off-platform .db file', uploadRestore.status === 200 && uploadInfo.source === 'upload' && uploadInfo.integrity === 'ok', `status=${uploadRestore.status} ${uploadRestore.text.slice(0, 200)}`);

  const feedAgain = await founder.get('/api/feed?limit=50');
  check('the post comes back from the uploaded file', (feedAgain.body?.posts || []).some((p) => p.id === postId), 'post missing after upload restore');

  const late2Login = await new Client(BASE, 'late2-again').post('/api/auth/login', { email: 'late2@ashmesh.test', password: 'Late2Pass123' });
  check('the later account is removed by the upload restore', late2Login.status === 401, `status=${late2Login.status}`);

  /* ---- audit trail and secret hygiene ---- */

  const auditRes = await founder.get('/api/admin/audit');
  check('backup and restore actions are recorded in the audit log', auditRes.status === 200 && /backup\.create/.test(auditRes.text) && /backup\.restore/.test(auditRes.text), `status=${auditRes.status}`);
  check('backup responses never expose credentials', !statusAfter.text.includes(FOUNDER_PASSWORD) && !/GROQ_API_KEY/.test(statusAfter.text) && !/DB_PATH/.test(statusAfter.text), 'a credential appeared in the response');

  await phase1.stop();

  /* ---- the scheduler writes snapshots with no user action ---- */

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ash-mesh-backup-scheduler-'));
  const phase2 = await boot({
    port: Number(process.env.BACKUP_SCHED_PORT || 4602),
    dataDir: dir2,
    env: { BACKUP_INITIAL_DELAY_MS: '1200', BACKUP_INTERVAL_MINUTES: '5', BACKUP_RETENTION: '3' },
  });
  const f2 = new Client(phase2.base, 'founder-2');
  await f2.post('/api/auth/login', { email: FOUNDER_EMAIL, password: FOUNDER_PASSWORD });

  let scheduled = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const state = await f2.get('/api/founder/backups');
    scheduled = (state.body?.backups || []).find((b) => b.reason === 'scheduled') || null;
    if (scheduled) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  check('the scheduler writes snapshots without any user action', !!scheduled && scheduled.integrity === 'ok', JSON.stringify(scheduled || {}).slice(0, 200));
  await phase2.stop();

  /* ---- summary ---- */

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n#ash Mesh backup drill: ${passed}/${results.length} checks passed`);
  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('backup drill crashed:', err);
  process.exit(1);
});
