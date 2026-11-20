// #ash AI Creative Studio — HTTP surface.
//
// Every endpoint here does real work or returns an explicit provider_required error.
// Nothing returns a fabricated file or a "success" for an operation that did not run.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, audit, UPLOAD_DIR } from './db.js';
import { requireAuth, upload, saveMedia, mediaAbsolutePath, rateLimit, clean, badRequest } from './lib.js';
import {
  capabilities, environment, ensureCreativeSchema, editImage, editAudio, editVideo,
  transcribeAudio, createDocument, createSpreadsheet, recordItem, serializeItem, storeGeneratedFile,
} from './creative.js';
import { groqChat, groqConfigured } from './ai-groq.js';

const router = express.Router();
ensureCreativeSchema();

function fail(res, err) {
  const status = err?.status || 500;
  const code = status === 503 ? 'provider_required' : status === 400 ? 'invalid_request' : 'creative_failed';
  res.status(status).json({ error: code, message: err?.message || 'That operation failed.' });
}

function opsFrom(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    const err = new Error('The edit instructions were not valid.');
    err.status = 400;
    throw err;
  }
}

function requireFile(req, res) {
  if (!req.file) {
    badRequest(res, 'Choose a file first.');
    return false;
  }
  return true;
}

/* ------------------------------ capabilities ------------------------------ */

router.get('/creative/capabilities', requireAuth, (_req, res) => {
  res.json({ capabilities: capabilities(), environment: environment() });
});

router.get('/creative/library', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM creative_items WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
  res.json({ items: rows.map(serializeItem) });
});

router.delete('/creative/library/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM creative_items WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Item not found.' });
  db.prepare('DELETE FROM creative_items WHERE id = ?').run(row.id);
  // Generated media is removed only when no published post still points at it.
  if (row.media_id) {
    const used = db.prepare('SELECT 1 FROM posts WHERE media_id = ? AND deleted_at IS NULL').get(row.media_id);
    if (!used) {
      const media = db.prepare('SELECT * FROM media WHERE id = ?').get(row.media_id);
      if (media) {
        try { fs.unlinkSync(path.join(UPLOAD_DIR, media.path)); } catch { /* already gone */ }
        db.prepare('DELETE FROM media WHERE id = ?').run(media.id);
      }
    }
  }
  audit(req.user.id, 'creative.delete', 'creative_item', row.id, { studio: row.studio });
  res.json({ ok: true });
});

/* --------------------------------- image ---------------------------------- */

router.post('/creative/image/edit', requireAuth, rateLimit({ name: 'creative', limit: 40, windowMs: 3600000 }), upload.single('file'), async (req, res) => {
  try {
    if (!requireFile(req, res)) return;
    const media = saveMedia({ file: req.file, ownerId: req.user.id, kind: 'image' });
    const inputPath = mediaAbsolutePath(media);
    if (!inputPath) throw Object.assign(new Error('That file is not available.'), { status: 404 });
    const result = await editImage({ inputPath, ops: opsFrom(req.body.ops), ext: clean(req.body.format, 8) || undefined });
    const out = storeGeneratedFile({ ownerId: req.user.id, kind: 'image', mime: result.mime, absPath: result.absPath });
    const item = recordItem({
      ownerId: req.user.id, studio: 'image', kind: 'image',
      title: clean(req.body.title, 120) || 'Edited image', op: 'edit',
      sourceMediaId: media.id, media: out, meta: { applied: result.applied },
    });
    audit(req.user.id, 'creative.image.edit', 'creative_item', item.id, { applied: result.applied });
    res.status(201).json({ item: serializeItem(item), applied: result.applied });
  } catch (err) { fail(res, err); }
});

/* ------------------------------ audio / video ----------------------------- */

router.post('/creative/audio/edit', requireAuth, rateLimit({ name: 'creative', limit: 40, windowMs: 3600000 }), upload.single('file'), async (req, res) => {
  try {
    if (!requireFile(req, res)) return;
    const media = saveMedia({ file: req.file, ownerId: req.user.id, kind: 'audio' });
    const inputPath = mediaAbsolutePath(media);
    if (!inputPath) throw Object.assign(new Error('That file is not available.'), { status: 404 });
    const result = await editAudio({ inputPath, ops: opsFrom(req.body.ops) });
    const out = storeGeneratedFile({ ownerId: req.user.id, kind: 'audio', mime: result.mime, absPath: result.absPath });
    const item = recordItem({
      ownerId: req.user.id, studio: 'audio', kind: 'audio',
      title: clean(req.body.title, 120) || 'Edited audio', op: 'edit',
      sourceMediaId: media.id, media: out, meta: { applied: result.applied },
    });
    audit(req.user.id, 'creative.audio.edit', 'creative_item', item.id, { applied: result.applied });
    res.status(201).json({ item: serializeItem(item), applied: result.applied });
  } catch (err) { fail(res, err); }
});

router.post('/creative/video/edit', requireAuth, rateLimit({ name: 'creative', limit: 30, windowMs: 3600000 }), upload.single('file'), async (req, res) => {
  try {
    if (!requireFile(req, res)) return;
    const media = saveMedia({ file: req.file, ownerId: req.user.id, kind: 'video' });
    const inputPath = mediaAbsolutePath(media);
    if (!inputPath) throw Object.assign(new Error('That file is not available.'), { status: 404 });
    const result = await editVideo({ inputPath, ops: opsFrom(req.body.ops) });
    const kind = result.mime === 'image/jpeg' ? 'image' : 'video';
    const out = storeGeneratedFile({ ownerId: req.user.id, kind, mime: result.mime, absPath: result.absPath });
    const item = recordItem({
      ownerId: req.user.id, studio: 'video', kind,
      title: clean(req.body.title, 120) || (kind === 'image' ? 'Video thumbnail' : 'Edited video'), op: 'edit',
      sourceMediaId: media.id, media: out, meta: { applied: result.applied },
    });
    audit(req.user.id, 'creative.video.edit', 'creative_item', item.id, { applied: result.applied });
    res.status(201).json({ item: serializeItem(item), applied: result.applied });
  } catch (err) { fail(res, err); }
});

router.post('/creative/transcribe', requireAuth, rateLimit({ name: 'creative-transcribe', limit: 20, windowMs: 3600000 }), upload.single('file'), async (req, res) => {
  try {
    if (!requireFile(req, res)) return;
    const kind = clean(req.body.kind, 10) === 'video' ? 'video' : 'audio';
    const media = saveMedia({ file: req.file, ownerId: req.user.id, kind });
    const inputPath = mediaAbsolutePath(media);
    if (!inputPath) throw Object.assign(new Error('That file is not available.'), { status: 404 });
    const result = await transcribeAudio({ inputPath, filename: media.path, language: clean(req.body.language, 8) });
    const item = recordItem({
      ownerId: req.user.id, studio: 'audio', kind: 'text',
      title: clean(req.body.title, 120) || 'Transcript', op: 'transcribe',
      sourceMediaId: media.id, textOutput: result.text, meta: { provider: result.provider, model: result.model },
    });
    audit(req.user.id, 'creative.transcribe', 'creative_item', item.id, { provider: result.provider });
    res.status(201).json({ item: serializeItem(item) });
  } catch (err) { fail(res, err); }
});

/* -------------------------------- documents ------------------------------- */

router.post('/creative/document', requireAuth, rateLimit({ name: 'creative', limit: 40, windowMs: 3600000 }), (req, res) => {
  try {
    const format = clean(req.body.format, 8) || 'md';
    const result = createDocument({ format, title: clean(req.body.title, 160), content: req.body.content });
    const out = storeGeneratedFile({ ownerId: req.user.id, kind: 'file', mime: result.mime, absPath: result.absPath });
    const item = recordItem({
      ownerId: req.user.id, studio: 'document', kind: 'file',
      title: clean(req.body.title, 160) || 'Document', op: 'create', media: out, meta: { format },
    });
    audit(req.user.id, 'creative.document', 'creative_item', item.id, { format });
    res.status(201).json({ item: serializeItem(item) });
  } catch (err) { fail(res, err); }
});

router.post('/creative/spreadsheet', requireAuth, rateLimit({ name: 'creative', limit: 40, windowMs: 3600000 }), (req, res) => {
  try {
    const result = createSpreadsheet({ title: clean(req.body.title, 160), rows: req.body.rows });
    const out = storeGeneratedFile({ ownerId: req.user.id, kind: 'file', mime: result.mime, absPath: result.absPath });
    const item = recordItem({
      ownerId: req.user.id, studio: 'spreadsheet', kind: 'file',
      title: clean(req.body.title, 160) || 'Spreadsheet', op: 'create', media: out, meta: { format: 'csv' },
    });
    audit(req.user.id, 'creative.spreadsheet', 'creative_item', item.id, { format: 'csv' });
    res.status(201).json({ item: serializeItem(item) });
  } catch (err) { fail(res, err); }
});

/* --------------------------- language assistance -------------------------- */

const WRITE_TASKS = {
  caption: 'Write short, engaging social-media captions. Return the caption text only, with no preamble.',
  article: 'Write a clear, well-structured article with headings. Return the article only.',
  script: 'Write a video script with scene directions and spoken lines. Return the script only.',
  hashtags: 'Return 12 relevant hashtags, one per line, each starting with #. Nothing else.',
  slogan: 'Return 5 original slogan options, one per line. Nothing else.',
  explain: 'Explain the subject clearly and accurately for a general audience. Say so if something is uncertain.',
  code: 'Write complete, runnable code with brief comments. Never claim the code was executed or tested.',
  translate: 'Translate the text faithfully into the requested language, preserving meaning and tone. Return only the translation.',
  summarize: 'Summarise the text faithfully. Do not add facts that are not present.',
  improve: 'Rewrite the text to be clearer and better written while preserving its meaning. Return only the rewrite.',
};

router.post('/creative/write', requireAuth, rateLimit({ name: 'creative-write', limit: 40, windowMs: 3600000 }), async (req, res) => {
  try {
    if (!groqConfigured()) {
      throw Object.assign(new Error('Writing assistance needs the Groq key on the server.'), { status: 503 });
    }
    const task = WRITE_TASKS[clean(req.body.task, 20)] ? clean(req.body.task, 20) : 'caption';
    const prompt = clean(req.body.prompt, 4000);
    if (!prompt) return badRequest(res, 'Describe what you want written.');
    const language = clean(req.body.language, 40);
    const system = `${WRITE_TASKS[task]} The user is writing for #ash Mesh. Never invent facts about real people or claim an action was completed.${language ? ` Respond in ${language}.` : ''}`;
    const result = await groqChat({ messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], maxTokens: 1200 });
    const item = recordItem({
      ownerId: req.user.id, studio: 'writing', kind: 'text',
      title: clean(req.body.title, 120) || 'Draft', prompt, op: task,
      textOutput: result.text, meta: { model: result.model },
    });
    audit(req.user.id, 'creative.write', 'creative_item', item.id, { task, model: result.model });
    res.status(201).json({ item: serializeItem(item), model: result.model });
  } catch (err) { fail(res, err); }
});

router.post('/creative/presentation', requireAuth, rateLimit({ name: 'creative-slides', limit: 20, windowMs: 3600000 }), async (req, res) => {
  try {
    if (!groqConfigured()) {
      throw Object.assign(new Error('Slide generation needs the Groq key on the server.'), { status: 503 });
    }
    const topic = clean(req.body.topic, 400);
    if (!topic) return badRequest(res, 'Describe the presentation topic.');
    const count = Math.min(Math.max(Number(req.body.slides) || 6, 3), 15);
    const result = await groqChat({
      messages: [
        { role: 'system', content: `Return JSON only: {"title": string, "slides": [{"heading": string, "bullets": string[]}]}. Exactly ${count} slides, 3-5 short bullets each. No commentary.` },
        { role: 'user', content: topic },
      ],
      json: true,
      maxTokens: 1600,
    });
    let deck;
    try { deck = JSON.parse(result.text); } catch { throw Object.assign(new Error('The slide outline could not be read. Please try again.'), { status: 502 }); }
    const slides = Array.isArray(deck.slides) ? deck.slides.slice(0, 15) : [];
    if (!slides.length) throw Object.assign(new Error('No slides were produced. Please try again.'), { status: 502 });

    const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(deck.title || topic)}</title>
<style>body{margin:0;background:#04120c;color:#eaf7ef;font-family:system-ui,sans-serif}
section{min-height:100vh;display:flex;flex-direction:column;justify-content:center;padding:8vh 8vw;border-bottom:1px solid #12452e}
h1,h2{color:#00ff88;margin:0 0 18px}li{margin:10px 0;font-size:1.25rem;line-height:1.5}</style></head><body>
<section><h1>${esc(deck.title || topic)}</h1><p>#ash Mesh · #ash AI Creative Studio</p></section>
${slides.map((slide) => `<section><h2>${esc(slide.heading)}</h2><ul>${(Array.isArray(slide.bullets) ? slide.bullets : []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul></section>`).join('')}
</body></html>`;

    const doc = createDocument({ format: 'html', title: deck.title || topic, content: html });
    const out = storeGeneratedFile({ ownerId: req.user.id, kind: 'file', mime: doc.mime, absPath: doc.absPath });
    const item = recordItem({
      ownerId: req.user.id, studio: 'presentation', kind: 'file',
      title: deck.title || topic, prompt: topic, op: 'create', media: out,
      meta: { slides: slides.length, format: 'html', model: result.model },
    });
    audit(req.user.id, 'creative.presentation', 'creative_item', item.id, { slides: slides.length });
    res.status(201).json({ item: serializeItem(item), slideCount: slides.length });
  } catch (err) { fail(res, err); }
});

export default router;
