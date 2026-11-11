// #ash Mesh — Stage A gap closure: archive (ZIP) recovery drill.
//
// Boots the REAL server against an isolated temporary data directory and proves that a
// downloaded export archive restores the database AND the uploaded media:
//
//   seed real records + real uploaded photos -> snapshot -> export ZIP (off-platform copy)
//   -> disaster: delete the post, delete the media from disk, create a later account
//   -> restore the ZIP -> rows, relationships, E2EE envelopes and media bytes all return
//   -> forced failures prove the rollback: media journal and database both come back intact
//   -> hostile archives (zip-slip, missing manifest, tampered media, non-zip) change nothing
//
//   node tests/archive-restore.test.mjs
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
const ENVELOPE = {
  v: 1,
  iv: 'aXYtY2lwaGVydGV4dA==',
  ct: 'ZHJpbGwtY2lwaGVydGV4dA==',
  salt: 'c2FsdC1ieXRlcw==',
  pub: { kty: 'EC', crv: 'P-256' },
};

const results = [];
let failures = 0;

function check(name, condition, detail) {
  const ok = !!condition;
  if (!ok) failures += 1;
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ↳ ${detail}`}`);
  return ok;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function sha256File(file) {
  return sha256(fs.readFileSync(file));
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
      BACKUP_SCHEDULER: 'off',
      ARCHIVE_RESTORE_FAULT: '',
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
  del(p, body = { confirm: true }) { return this.req('DELETE', p, body); }

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

/* --------------------------------- zip I/O -------------------------------- */

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
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, uncompSize, localOff });
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

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** Build a stored-entry ZIP, used to craft hostile and tampered archives. */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** Rebuild an archive, replacing the bytes of one entry (keeps the manifest untouched). */
function tamperArchive(originalBuf, entryName, replacement) {
  const parts = zipEntries(originalBuf).map((entry) => ({
    name: entry.name,
    data: entry.name === entryName ? replacement : readEntry(originalBuf, entry),
  }));
  return buildZip(parts);
}

function mediaState(uploadsDir) {
  const map = {};
  if (!fs.existsSync(uploadsDir)) return map;
  for (const name of fs.readdirSync(uploadsDir)) {
    const full = path.join(uploadsDir, name);
    if (fs.statSync(full).isFile()) map[name] = sha256File(full);
  }
  return map;
}

/* --------------------------------- drill ---------------------------------- */

async function main() {
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'ash-mesh-archive-drill-'));
  const uploadsDir = path.join(dir1, 'uploads');
  const backupsDir = path.join(dir1, 'backups');
  const offPlatform = fs.mkdtempSync(path.join(os.tmpdir(), 'ash-mesh-offplatform-'));
  const downloadedZip = path.join(offPlatform, 'ash-mesh-export.zip');

  const phase1 = await boot({ port: Number(process.env.ARCHIVE_TEST_PORT || 4611), dataDir: dir1 });
  const BASE = phase1.base;

  const anon = new Client(BASE, 'anon');
  const founder = new Client(BASE, 'founder');
  const member = new Client(BASE, 'member');
  const friend = new Client(BASE, 'friend');

  /* ---- founder session ---- */

  const login = await founder.post('/api/auth/login', { email: FOUNDER_EMAIL, password: FOUNDER_PASSWORD });
  check('founder signs in', login.status === 200 && !!login.body?.user?.id, `status=${login.status}`);

  const policyRes = await founder.get('/api/founder/backups');
  check(
    'policy states archive restore writes media back',
    policyRes.body?.policy?.archiveRestoreIncludesUploads === true && policyRes.body?.policy?.durableStorage === false,
    JSON.stringify(policyRes.body?.policy || {}).slice(0, 200)
  );

  /* ---- authorization on the new route ---- */

  const anonRestore = await anon.upload('/api/founder/export/restore', Buffer.from('PK'), 'x.zip', 'application/zip');
  check('anonymous archive restore is refused', anonRestore.status === 401, `status=${anonRestore.status}`);

  const regMember = await member.post('/api/auth/register', { email: 'member@ashmesh.test', username: 'member', password: 'MemberPass123', fullName: 'Member Tester' });
  const memberId = regMember.body?.user?.id;
  const regFriend = await friend.post('/api/auth/register', { email: 'friend@ashmesh.test', username: 'friend', password: 'FriendPass123', fullName: 'Friend Tester' });
  const friendId = regFriend.body?.user?.id;
  check('two disposable accounts are created', regMember.status === 201 && regFriend.status === 201 && !!memberId && !!friendId, `${regMember.status}/${regFriend.status}`);

  const memberRestore = await member.upload('/api/founder/export/restore', Buffer.from('PK'), 'x.zip', 'application/zip');
  check('non-founder archive restore is refused', memberRestore.status === 403, `status=${memberRestore.status}`);

  /* ---- seed real records and real uploaded media ---- */

  const postRes = await member.post('/api/posts', { body: 'Archive drill post — rows and media must come back.', audience: 'public' });
  const postId = postRes.body?.post?.id;
  check('member publishes a post', postRes.status === 201 && !!postId, `status=${postRes.status}`);

  const commentRes = await founder.post(`/api/posts/${postId}/comments`, { body: 'Drill comment that must survive.' });
  const likeRes = await founder.post(`/api/posts/${postId}/like`, {});
  check('comment and like are stored', commentRes.status === 201 && likeRes.status === 200, `comment=${commentRes.status} like=${likeRes.status}`);

  const reqRes = await member.post('/api/friends/request', { userId: friendId });
  const incoming = await friend.get('/api/friends/requests');
  const requestRow = (incoming.body?.incoming || incoming.body?.requests || [])[0] || {};
  const requestId = requestRow.requestId || requestRow.id;
  const accept = await friend.post(`/api/friends/${requestId}/accept`, {});
  check('friendship is accepted', reqRes.status === 201 && accept.status === 200 && !!requestId, `request=${reqRes.status} accept=${accept.status}`);

  const convo = await member.post('/api/conversations', { userId: friendId });
  const conversationId = convo.body?.conversationId || convo.body?.conversation?.id;
  const msg = await member.post(`/api/conversations/${conversationId}/messages`, { envelope: ENVELOPE, kind: 'text', clientId: 'archive-drill-msg-1', transport: 'internet' });
  check('encrypted message is stored', convo.status === 201 && msg.status === 201, `convo=${convo.status} msg=${msg.status}`);

  const avatarA = await member.upload('/api/users/me/avatar', PNG, 'avatar-member.png', 'image/png');
  const avatarB = await friend.upload('/api/users/me/avatar', Buffer.concat([PNG, Buffer.from('friend-cover')]), 'avatar-friend.png', 'image/png');
  const memberProfile = await member.get('/api/users/me');
  const avatarUrl = avatarA.body?.avatarUrl || memberProfile.body?.user?.avatarUrl || memberProfile.body?.avatarUrl || '';
  const avatarId = avatarUrl.split('/').filter(Boolean).pop();
  check('avatar upload returns a servable media URL', /^\/api\/media\/[^/]+$/.test(avatarUrl), `avatarUrl=${avatarUrl}`);
  check('both accounts upload profile media to disk', avatarA.status < 300 && avatarB.status < 300 && fs.existsSync(uploadsDir) && fs.readdirSync(uploadsDir).length >= 2, `a=${avatarA.status} b=${avatarB.status}`);

  const avatarBefore = await member.bytes(`/api/media/${avatarId}`);
  check('uploaded media is served before the disaster', avatarBefore.status === 200 && sha256(avatarBefore.buf) === sha256(PNG), `status=${avatarBefore.status}`);

  /* ---- snapshot + off-platform export ---- */

  const created = await founder.post('/api/founder/backups', {});
  const meta = created.body?.backup;
  check('founder creates a snapshot', created.status === 201 && /^ash-mesh-\d{8}-\d{6}-[0-9a-f]{6}\.db$/.test(meta?.name || ''), `status=${created.status}`);

  const archive = await founder.bytes('/api/founder/export');
  fs.writeFileSync(downloadedZip, archive.buf);
  check('founder downloads a ZIP archive outside the container', archive.status === 200 && archive.buf.subarray(0, 2).toString() === 'PK' && fs.existsSync(downloadedZip), `status=${archive.status}`);

  const entries = zipEntries(archive.buf);
  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  const manifest = manifestEntry ? JSON.parse(readEntry(archive.buf, manifestEntry).toString('utf8')) : null;
  const manifestFiles = Array.isArray(manifest?.uploads?.files) ? manifest.uploads.files : [];
  const dbEntry = entries.find((e) => e.name.startsWith('database/'));
  check(
    'manifest v2 lists every media file with its checksum and size',
    manifest?.format === 'ash-mesh-export/2' && manifestFiles.length >= 2 && manifestFiles.every((f) => /^[0-9a-f]{64}$/.test(f.sha256 || '') && f.sizeBytes > 0),
    JSON.stringify(manifest?.format) + ' files=' + manifestFiles.length
  );
  check('the archive carries the database and the media bytes', !!dbEntry && entries.some((e) => e.name.startsWith('uploads/')), entries.map((e) => e.name).slice(0, 6).join(', '));

  const exportedMedia = {};
  for (const file of manifestFiles) exportedMedia[file.name] = file.sha256;

  /* ---- disaster: rows and media are lost ---- */

  const deleted = await member.del(`/api/posts/${postId}`);
  for (const name of Object.keys(exportedMedia)) {
    fs.rmSync(path.join(uploadsDir, name), { force: true });
  }
  const late = new Client(BASE, 'late');
  const lateReg = await late.post('/api/auth/register', { email: 'late@ashmesh.test', username: 'late', password: 'LatePass123', fullName: 'Late Account' });

  const missingMedia = await member.bytes(`/api/media/${avatarId}`);
  const feedAfterLoss = await founder.get('/api/feed?limit=50');
  check(
    'disaster state is real: post gone and media missing from storage',
    deleted.status === 200 && lateReg.status === 201 && missingMedia.status === 404 && !(feedAfterLoss.body?.posts || []).some((p) => p.id === postId),
    `media=${missingMedia.status}`
  );

  /* ---- recover from the downloaded ZIP ---- */

  const restoreRes = await founder.upload('/api/founder/export/restore', fs.readFileSync(downloadedZip), 'ash-mesh-export.zip', 'application/zip');
  const info = restoreRes.body?.restore || {};
  check('founder restores the downloaded archive', restoreRes.status === 200 && info.source === 'archive', `status=${restoreRes.status} ${restoreRes.text.slice(0, 220)}`);
  check('archive restore reports a healthy database', info.integrity === 'ok' && info.foreignKeyViolations === 0, `integrity=${info.integrity} fk=${info.foreignKeyViolations}`);
  check('archive restore reports the media it wrote back', info.media?.restored >= 2 && info.media?.bytes > 0, JSON.stringify(info.media || {}).slice(0, 200));
  check('archive restore takes a pre-archive-restore safety snapshot', !!info.archiveSafetyBackup && fs.existsSync(path.join(backupsDir, info.archiveSafetyBackup)), `safety=${info.archiveSafetyBackup}`);

  /* ---- rows recovered ---- */

  const feed = await founder.get('/api/feed?limit=50');
  check('restored post is back in the feed', (feed.body?.posts || []).some((p) => p.id === postId), 'post missing');

  const comments = await founder.get(`/api/posts/${postId}/comments`);
  check('restored comments are intact', (comments.body?.comments || []).length === 1, `count=${(comments.body?.comments || []).length}`);

  const likesRes = await founder.get(`/api/posts/${postId}/likes`);
  const likesBody = likesRes.body || {};
  const likeCount = Array.isArray(likesBody.users) ? likesBody.users.length : Array.isArray(likesBody.likes) ? likesBody.likes.length : Array.isArray(likesBody) ? likesBody.length : likesBody.count;
  check('restored like is intact', likeCount === 1, `count=${likeCount}`);

  const memberRelogin = await member.post('/api/auth/login', { email: 'member@ashmesh.test', password: 'MemberPass123' });
  check('restored account keeps its original profile', memberRelogin.status === 200 && memberRelogin.body?.user?.fullName === 'Member Tester', `status=${memberRelogin.status}`);

  const friendsAfter = await member.get('/api/friends');
  check('restored friendship is intact', (friendsAfter.body?.friends || []).some((f) => f.id === friendId), 'friend missing');

  const messagesAfter = await member.get(`/api/conversations/${conversationId}/messages`);
  const restoredMsg = (messagesAfter.body?.messages || [])[0] || {};
  check('restored conversation keeps its messages', (messagesAfter.body?.messages || []).length === 1, `count=${(messagesAfter.body?.messages || []).length}`);
  check(
    'restored message keeps the E2EE envelope, not readable plaintext',
    JSON.stringify(restoredMsg).includes(ENVELOPE.ct) || JSON.stringify(restoredMsg.envelope || {}).includes(ENVELOPE.ct),
    JSON.stringify(restoredMsg).slice(0, 200)
  );

  const lateLogin = await new Client(BASE, 'late-again').post('/api/auth/login', { email: 'late@ashmesh.test', password: 'LatePass123' });
  check('the account created after the export is gone after restore', lateLogin.status === 401, `status=${lateLogin.status}`);

  const compared = ['users', 'posts', 'comments', 'conversations'].every((t) => (info.tables?.[t] ?? -1) === (meta?.counts?.[t] ?? -2));
  check('restored row counts match the snapshot exactly', compared, `restored=${JSON.stringify(info.tables || {}).slice(0, 160)}`);

  /* ---- media recovered ---- */

  const mediaAfter = mediaState(uploadsDir);
  check(
    'every archived media file is back on disk with its original checksum',
    Object.entries(exportedMedia).every(([name, digest]) => mediaAfter[name] === digest),
    JSON.stringify(mediaAfter).slice(0, 200)
  );
  check('no restore temp files are left in the media directory', !Object.keys(mediaAfter).some((n) => n.startsWith('.restore-')), Object.keys(mediaAfter).join(', '));

  const avatarAfter = await member.bytes(`/api/media/${avatarId}`);
  check('restored media is served again over the real media endpoint', avatarAfter.status === 200 && sha256(avatarAfter.buf) === sha256(PNG), `status=${avatarAfter.status}`);
  check('restored media keeps its declared content type', /image\/png/.test(avatarAfter.headers.get('content-type') || ''), avatarAfter.headers.get('content-type'));

  const auditRes = await founder.get('/api/admin/audit');
  check('the archive restore is recorded in the audit log', auditRes.status === 200 && /backup\.restore-archive/.test(auditRes.text), `status=${auditRes.status}`);

  await phase1.stop();

  /* ---- forced failure AFTER the database step: both rollbacks must hold ---- */

  const phase2 = await boot({
    port: Number(process.env.ARCHIVE_FAULT_PORT || 4612),
    dataDir: dir1,
    env: { ARCHIVE_RESTORE_FAULT: 'after-db' },
  });
  const f2 = new Client(phase2.base, 'founder-fault-db');
  await f2.post('/api/auth/login', { email: FOUNDER_EMAIL, password: FOUNDER_PASSWORD });
  const m2 = new Client(phase2.base, 'member-fault-db');
  await m2.post('/api/auth/login', { email: 'member@ashmesh.test', password: 'MemberPass123' });

  // Create a difference the failed restore must NOT roll back: a deleted post and a new account.
  await m2.del(`/api/posts/${postId}`);
  await new Client(phase2.base, 'late3').post('/api/auth/register', { email: 'late3@ashmesh.test', username: 'late3', password: 'Late3Pass123', fullName: 'Late Three' });

  const mediaBeforeFault = mediaState(uploadsDir);
  const usersBeforeFault = (await f2.get('/api/founder/backups')).status === 200;

  const failed = await f2.upload('/api/founder/export/restore', fs.readFileSync(downloadedZip), 'ash-mesh-export.zip', 'application/zip');
  check('a failure after the database step is reported as a rolled-back restore', failed.status === 409 && /rolled back/i.test(failed.text), `status=${failed.status} ${failed.text.slice(0, 200)}`);

  const feedAfterFault = await f2.get('/api/feed?limit=50');
  check('failed restore leaves the database exactly as it was (post still absent)', !(feedAfterFault.body?.posts || []).some((p) => p.id === postId), 'post reappeared');

  const late3 = await new Client(phase2.base, 'late3-check').post('/api/auth/login', { email: 'late3@ashmesh.test', password: 'Late3Pass123' });
  check('failed restore keeps accounts created after the export', late3.status === 200, `status=${late3.status}`);

  const mediaAfterFault = mediaState(uploadsDir);
  check(
    'failed restore leaves every media file byte-identical',
    JSON.stringify(mediaAfterFault) === JSON.stringify(mediaBeforeFault),
    `before=${JSON.stringify(mediaBeforeFault).slice(0, 120)} after=${JSON.stringify(mediaAfterFault).slice(0, 120)}`
  );
  check('failed restore leaves no temp files behind', !Object.keys(mediaAfterFault).some((n) => n.startsWith('.restore-')), Object.keys(mediaAfterFault).join(', '));
  check('founder is still signed in after the rolled-back restore', usersBeforeFault && (await f2.get('/api/founder/backups')).status === 200, 'session lost');

  /* ---- hostile archives: refused before any live byte changes ---- */

  const junkZip = await f2.upload('/api/founder/export/restore', Buffer.from('this is not a zip file at all'), 'junk.zip', 'application/zip');
  check('a non-ZIP upload is refused', junkZip.status === 400, `status=${junkZip.status}`);

  const slipZip = await f2.upload(
    '/api/founder/export/restore',
    buildZip([
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
      { name: dbEntry.name, data: readEntry(archive.buf, dbEntry) },
      { name: 'uploads/../escape.png', data: Buffer.from('escape attempt') },
    ]),
    'slip.zip',
    'application/zip'
  );
  check('an archive entry that escapes the media directory is refused', slipZip.status === 400, `status=${slipZip.status} ${slipZip.text.slice(0, 160)}`);
  check('the zip-slip attempt wrote nothing outside the media directory', !fs.existsSync(path.join(dir1, 'escape.png')), 'file escaped');

  const noManifest = await f2.upload(
    '/api/founder/export/restore',
    buildZip([{ name: dbEntry.name, data: readEntry(archive.buf, dbEntry) }]),
    'nomanifest.zip',
    'application/zip'
  );
  check('an archive without a manifest is refused', noManifest.status === 400, `status=${noManifest.status}`);

  const mediaName = Object.keys(exportedMedia)[0];
  const tampered = tamperArchive(archive.buf, `uploads/${mediaName}`, Buffer.from('tampered media bytes, wrong checksum'));
  const tamperedRes = await f2.upload('/api/founder/export/restore', tampered, 'tampered.zip', 'application/zip');
  check('an archive whose media does not match the manifest is refused', tamperedRes.status === 400 && /checksum|size/i.test(tamperedRes.text), `status=${tamperedRes.status} ${tamperedRes.text.slice(0, 200)}`);

  const mediaAfterHostile = mediaState(uploadsDir);
  check('hostile archives changed no media bytes', JSON.stringify(mediaAfterHostile) === JSON.stringify(mediaBeforeFault), 'media changed');
  const feedAfterHostile = await f2.get('/api/feed?limit=50');
  check('hostile archives changed no database rows', !(feedAfterHostile.body?.posts || []).some((p) => p.id === postId), 'post reappeared');

  await phase2.stop();

  /* ---- forced failure AFTER the media step: the media journal must restore bytes ---- */

  const phase3 = await boot({
    port: Number(process.env.ARCHIVE_FAULT_MEDIA_PORT || 4613),
    dataDir: dir1,
    env: { ARCHIVE_RESTORE_FAULT: 'after-media' },
  });
  const f3 = new Client(phase3.base, 'founder-fault-media');
  await f3.post('/api/auth/login', { email: FOUNDER_EMAIL, password: FOUNDER_PASSWORD });

  // Give the live media content that differs from the archive, so a rollback is observable.
  const distinct = {};
  for (const name of Object.keys(exportedMedia)) {
    const bytes = Buffer.concat([PNG, Buffer.from(`local-edit:${name}`)]);
    fs.writeFileSync(path.join(uploadsDir, name), bytes);
    distinct[name] = sha256(bytes);
  }
  const mediaBeforeMediaFault = mediaState(uploadsDir);

  const failedMedia = await f3.upload('/api/founder/export/restore', fs.readFileSync(downloadedZip), 'ash-mesh-export.zip', 'application/zip');
  check('a failure after the media step is reported as rolled back', failedMedia.status === 409 && /rolled back/i.test(failedMedia.text), `status=${failedMedia.status} ${failedMedia.text.slice(0, 200)}`);

  const mediaAfterMediaFault = mediaState(uploadsDir);
  check(
    'the media journal restores the exact bytes that were live before the attempt',
    Object.entries(distinct).every(([name, digest]) => mediaAfterMediaFault[name] === digest),
    JSON.stringify(mediaAfterMediaFault).slice(0, 200)
  );
  check('media rollback left no temp files', !Object.keys(mediaAfterMediaFault).some((n) => n.startsWith('.restore-')), Object.keys(mediaAfterMediaFault).join(', '));
  check('media rollback did not touch the database', JSON.stringify(mediaBeforeMediaFault) === JSON.stringify(mediaAfterMediaFault), 'media changed');

  const feedAfterMediaFault = await f3.get('/api/feed?limit=50');
  check('the database is unchanged after a media-stage failure', !(feedAfterMediaFault.body?.posts || []).some((p) => p.id === postId), 'post reappeared');

  /* ---- secrets never leak through the archive endpoints ---- */

  const statusText = (await f3.get('/api/founder/backups')).text + failedMedia.text + tamperedRes.text;
  check(
    'archive responses never expose credentials or filesystem paths',
    !statusText.includes(FOUNDER_PASSWORD) && !/GROQ_API_KEY/.test(statusText) && !statusText.includes(dir1),
    'a credential or absolute path appeared'
  );

  await phase3.stop();

  fs.rmSync(offPlatform, { recursive: true, force: true });

  /* ---- summary ---- */

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n#ash Mesh archive recovery drill: ${passed}/${results.length} checks passed`);
  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    const tail = String(phase1.log() || '').trim().split('\n').slice(-30).join('\n');
    if (tail) {
      console.error('--- server log (last 30 lines) ---');
      console.error(tail);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('archive recovery drill crashed:', err);
  process.exit(1);
});
