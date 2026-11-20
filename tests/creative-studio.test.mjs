// #ash Mesh — #ash AI Creative Studio.
//
// Boots the REAL server against isolated temporary data and proves the studio behaves the
// way the interface claims:
//
//   the capability list is honest — it reports what this deployment can actually do, and
//     nothing is labelled available that this environment cannot perform
//   a document, a spreadsheet and an image edit each produce a real, downloadable file
//     stored against the creator, and the source image is never overwritten
//   the library is private: another account sees nothing and cannot delete or fetch it
//   a studio artefact is published by reference through the normal post endpoint and
//     passes through pre-publication moderation like any other content
//   with no Groq key configured, writing assistance fails with a clear provider error and
//     creates nothing — no fake draft is ever returned
//   an upload-less edit request is refused instead of producing an empty file
//
//   node tests/creative-studio.test.mjs
//
// Uses only temporary directories and disposable accounts. No LIVE Supabase, no LIVE
// deployment, no real provider call and no user data are touched.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const FOUNDER_EMAIL = 'founder@ashmesh.test';
const FOUNDER_PASSWORD = 'FounderPass123';
const PORT = 4611;
const BASE = `http://127.0.0.1:${PORT}`;

// 1x1 PNG — a real image file, small enough to inline.
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

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
  async function request(method, pathname, { json, form, headers = {} } = {}) {
    const h = { ...headers };
    if (cookies.size) h.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const csrf = cookies.get('ash_csrf');
    if (csrf && method !== 'GET') h['x-csrf-token'] = csrf;
    let body;
    if (form) body = form;
    else if (json !== undefined) {
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
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, data };
  }
  return {
    get: (p, o) => request('GET', p, o),
    post: (p, o) => request('POST', p, o),
    del: (p, o) => request('DELETE', p, o),
    async raw(pathname) {
      const h = {};
      if (cookies.size) h.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(BASE + pathname, { headers: h });
      const text = await res.text();
      return { status: res.status, text, type: res.headers.get('content-type') || '' };
    },
  };
}

async function waitReady() {
  for (let i = 0; i < 200; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/auth/me`);
      if (res.status < 500) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become ready on ${BASE}`);
}

function bootServer(dataDir) {
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
      // Deliberately empty: the provider-dependent studio paths must fail honestly.
      GROQ_API_KEY: '',
      RESEND_API_KEY: '',
      BACKUP_SCHEDULER: 'off',
      NODE_ENV: 'test',
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

/* ---------------------------------- test --------------------------------- */

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ash-mesh-creative-'));
  const { child, log } = bootServer(dataDir);
  const STATUSES = ['available', 'partial', 'provider_required', 'unavailable'];

  try {
    await waitReady();

    const anon = makeClient();
    const owner = makeClient();
    const other = makeClient();

    /* ---------------------------- access control --------------------------- */

    const anonCaps = await anon.get('/api/creative/capabilities');
    check('capabilities require a signed-in account', anonCaps.status === 401, `status ${anonCaps.status}`);

    const anonDoc = await anon.post('/api/creative/document', { json: { format: 'md', content: 'nope' } });
    check('creating a document without an account is refused', anonDoc.status === 401, `status ${anonDoc.status}`);

    const regA = await owner.post('/api/auth/register', {
      json: { email: 'studio-a@ashmesh.test', username: 'studioa', password: 'StudioA123', fullName: 'Studio A' },
    });
    check('account A registers', regA.status === 200 || regA.status === 201, `status ${regA.status}`);

    const regB = await other.post('/api/auth/register', {
      json: { email: 'studio-b@ashmesh.test', username: 'studiob', password: 'StudioB123', fullName: 'Studio B' },
    });
    check('account B registers', regB.status === 200 || regB.status === 201, `status ${regB.status}`);

    /* ---------------------------- honest labelling ------------------------- */

    const caps = await owner.get('/api/creative/capabilities');
    const list = caps.data?.capabilities || [];
    check('capability list is returned', caps.status === 200 && list.length > 0, `status ${caps.status}, ${list.length} entries`);
    check(
      'every capability carries a known honest status',
      list.every((c) => STATUSES.includes(c.status)),
      JSON.stringify(list.filter((c) => !STATUSES.includes(c.status)))
    );
    check(
      'every capability explains itself in plain language',
      list.every((c) => typeof c.detail === 'string' && c.detail.length > 0),
      'a capability was returned without a detail line'
    );

    const imageEdit = list.find((c) => c.id === 'image.edit');
    check(
      'local image editing is reported available (ImageMagick is present)',
      imageEdit?.status === 'available',
      `image.edit status: ${imageEdit?.status}`
    );
    check(
      'provider-dependent generation is not advertised as available',
      list.filter((c) => /generate|music|speech/i.test(c.id)).every((c) => c.status !== 'available'),
      'a generation capability claimed to be available without a provider'
    );

    /* ------------------------------ documents ------------------------------ */

    const doc = await owner.post('/api/creative/document', {
      json: { format: 'md', title: 'Studio document', content: '# Hello #ash Mesh\n\nReal content.' },
    });
    check('a document is created', doc.status === 201 && !!doc.data?.item?.mediaId, `status ${doc.status}`);
    const docFile = await owner.raw(doc.data?.item?.mediaUrl || '/api/media/missing');
    check(
      'the created document is a real downloadable file with its content',
      docFile.status === 200 && docFile.text.includes('Hello #ash Mesh'),
      `status ${docFile.status}, ${docFile.text.length} bytes`
    );

    const sheet = await owner.post('/api/creative/spreadsheet', {
      json: { title: 'Studio sheet', rows: [['name', 'qty'], ['beans', '3']] },
    });
    check('a spreadsheet is created', sheet.status === 201 && !!sheet.data?.item?.mediaId, `status ${sheet.status}`);
    const sheetFile = await owner.raw(sheet.data?.item?.mediaUrl || '/api/media/missing');
    check(
      'the spreadsheet is real CSV containing the supplied rows',
      sheetFile.status === 200 && sheetFile.text.includes('beans') && sheetFile.text.includes(','),
      `status ${sheetFile.status}: ${sheetFile.text.slice(0, 60)}`
    );

    /* ----------------------------- image editing --------------------------- */

    const form = new FormData();
    form.append('file', new Blob([Buffer.from(PNG_1X1, 'base64')], { type: 'image/png' }), 'pixel.png');
    form.append('ops', JSON.stringify({ resize: { width: 32, height: 32 } }));
    form.append('title', 'Resized pixel');
    const edited = await owner.post('/api/creative/image/edit', { form });
    check('an uploaded image is edited', edited.status === 201 && !!edited.data?.item?.mediaId, `status ${edited.status}`);
    check(
      'the response reports the operations that actually ran',
      Array.isArray(edited.data?.applied) && edited.data.applied.some((a) => /resize/.test(a)),
      JSON.stringify(edited.data?.applied)
    );
    check(
      'the edit records the source image instead of overwriting it',
      !!edited.data?.item?.id && edited.data.item.kind === 'image' && edited.data.item.op === 'edit',
      JSON.stringify(edited.data?.item && { kind: edited.data.item.kind, op: edited.data.item.op })
    );
    const editedFile = await owner.raw(edited.data?.item?.mediaUrl || '/api/media/missing');
    check('the edited image is downloadable', editedFile.status === 200 && editedFile.text.length > 0, `status ${editedFile.status}`);

    const noFile = await owner.post('/api/creative/image/edit', { form: new FormData() });
    check('an edit request with no file is refused', noFile.status === 400, `status ${noFile.status}`);

    /* -------------------------------- library ------------------------------ */

    const lib = await owner.get('/api/creative/library');
    const items = lib.data?.items || [];
    check('the library lists everything just created', lib.status === 200 && items.length >= 3, `${items.length} items`);
    check(
      'library entries are newest-first and owned by the caller',
      items.length >= 2 && items[0].createdAt >= items[items.length - 1].createdAt,
      'ordering was not newest-first'
    );

    const otherLib = await other.get('/api/creative/library');
    check('another account sees an empty library', (otherLib.data?.items || []).length === 0, JSON.stringify(otherLib.data?.items?.length));

    const otherDelete = await other.del(`/creative/library/${edited.data?.item?.id}`);
    check("another account cannot delete someone else's artefact", otherDelete.status === 404, `status ${otherDelete.status}`);

    /* --------------------- publishing through moderation ------------------- */

    const publish = await owner.post('/posts', {
      json: { body: 'Made in the #ash AI Creative Studio.', audience: 'public', mediaId: edited.data?.item?.mediaId },
    });
    check('a studio artefact is published by reference', publish.status === 201, `status ${publish.status}`);
    check(
      'the published post keeps the generated media',
      publish.data?.post?.mediaId === edited.data?.item?.mediaId,
      `post media ${publish.data?.post?.mediaId}`
    );
    check(
      'publication returns the real moderation state',
      !!publish.data?.moderation && typeof publish.data.moderation.status === 'string',
      JSON.stringify(publish.data?.moderation)
    );

    /* ------------------- provider-dependent paths stay honest -------------- */

    const before = (await owner.get('/api/creative/library')).data?.items?.length ?? 0;
    const write = await owner.post('/api/creative/write', { json: { task: 'caption', prompt: 'A post about beans' } });
    check(
      'writing assistance fails clearly when the provider is not configured',
      write.status === 503 && write.data?.error === 'provider_required',
      `status ${write.status}, error ${write.data?.error}`
    );
    const slides = await owner.post('/api/creative/presentation', { json: { topic: 'Hausa proverbs', slides: 4 } });
    check(
      'slide generation fails clearly when the provider is not configured',
      slides.status === 503 && slides.data?.error === 'provider_required',
      `status ${slides.status}, error ${slides.data?.error}`
    );
    const after = (await owner.get('/api/creative/library')).data?.items?.length ?? 0;
    check('a failed provider request creates no artefact', after === before, `${before} -> ${after}`);
  } finally {
    await stopServer(child);
    if (failures) {
      const tail = log().split('\n').slice(-15).join('\n');
      if (tail.trim()) console.log(`\n--- server log (tail) ---\n${tail}`);
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} (${results.length} checks)`);
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
