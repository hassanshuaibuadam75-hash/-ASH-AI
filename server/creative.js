// #ash AI Creative Studio — real media and document engine.
//
// Design rule for this module: a capability is advertised only when the operation can
// actually run in this environment. ImageMagick and ffmpeg perform the media work, Groq
// performs the language work. Generative image / video / music providers are NOT
// configured, so those are reported as provider_required instead of returning a
// placeholder "result" the user could mistake for real output.
import { spawnSync, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, uid, now, UPLOAD_DIR } from './db.js';
import { groqConfigured } from './ai-groq.js';

const RUN_TIMEOUT = 120000;
const MAX_EDGE = 8192;

/* ------------------------------ capabilities ------------------------------ */

function hasBinary(name) {
  const probe = spawnSync(name, ['-version'], { stdio: 'ignore', timeout: 5000 });
  return probe.status === 0;
}

/** Live probe of what this container can genuinely do right now. */
export function environment() {
  return {
    imagemagick: hasBinary('convert'),
    ffmpeg: hasBinary('ffmpeg'),
    groq: groqConfigured(),
  };
}

/**
 * The capability registry. Statuses:
 *   available        — implemented and runnable in this environment
 *   partial          — some formats/operations work, others do not
 *   provider_required— needs an external provider or library that is not configured
 *   unavailable      — cannot run here at all
 */
export function capabilities() {
  const env = environment();
  const media = env.imagemagick && env.ffmpeg;
  return [
    { id: 'image.edit', studio: 'image', label: 'Edit an image (resize, crop, rotate, light, colour, text, format)', status: env.imagemagick ? 'available' : 'unavailable', detail: env.imagemagick ? 'Runs on this server with ImageMagick. The original file is never modified.' : 'ImageMagick is not installed in this environment.' },
    { id: 'image.generate', studio: 'image', label: 'Create a new image from text', status: 'provider_required', detail: 'Needs a text-to-image provider. No image provider key is configured, so nothing is generated and no fake image is returned.' },
    { id: 'image.understand', studio: 'image', label: 'Describe or read text from an image', status: 'provider_required', detail: 'Needs a vision model. The configured Groq model is text-only.' },
    { id: 'video.edit', studio: 'video', label: 'Trim a video, convert format, extract a thumbnail', status: env.ffmpeg ? 'available' : 'unavailable', detail: env.ffmpeg ? 'Runs on this server with ffmpeg. Your original video is preserved.' : 'ffmpeg is not installed in this environment.' },
    { id: 'video.generate', studio: 'video', label: 'Create a new video from text or images', status: 'provider_required', detail: 'Needs a video-generation provider. None is configured.' },
    { id: 'video.transcribe', studio: 'video', label: 'Transcribe speech in a video', status: media && env.groq ? 'available' : 'provider_required', detail: media && env.groq ? 'Audio is extracted with ffmpeg and transcribed by Groq Whisper.' : 'Requires ffmpeg plus the Groq key.' },
    { id: 'audio.edit', studio: 'audio', label: 'Trim, convert or change the volume of audio', status: env.ffmpeg ? 'available' : 'unavailable', detail: env.ffmpeg ? 'Runs on this server with ffmpeg.' : 'ffmpeg is not installed in this environment.' },
    { id: 'audio.transcribe', studio: 'audio', label: 'Transcribe audio to text', status: env.groq ? 'available' : 'provider_required', detail: env.groq ? 'Sent to Groq Whisper only when you press Transcribe.' : 'Requires the Groq key on the server.' },
    { id: 'audio.tts', studio: 'audio', label: 'Speak a written script (text to speech)', status: 'provider_required', detail: 'Needs a speech provider. None is configured, so no audio is produced.' },
    { id: 'audio.music', studio: 'audio', label: 'Generate original music', status: 'provider_required', detail: 'Needs a music-generation provider. None is configured.' },
    { id: 'document.create', studio: 'document', label: 'Create Markdown, text, CSV or HTML documents', status: 'available', detail: 'Written directly on this server as real, openable files.' },
    { id: 'document.office', studio: 'document', label: 'Export DOCX / XLSX / PPTX', status: 'unavailable', detail: 'No Office document library is installed, so these formats are not offered rather than faked.' },
    { id: 'document.write', studio: 'document', label: 'Write, rewrite or summarise text with #ash AI', status: env.groq ? 'available' : 'provider_required', detail: env.groq ? 'Uses the configured Groq model through the server.' : 'Requires the Groq key on the server.' },
    { id: 'presentation.create', studio: 'presentation', label: 'Build a slide outline and slide deck (HTML)', status: env.groq ? 'partial' : 'provider_required', detail: env.groq ? 'Slides are generated as a real HTML deck; PPTX export needs an Office library that is not installed.' : 'Requires the Groq key on the server.' },
    { id: 'spreadsheet.create', studio: 'spreadsheet', label: 'Build a CSV spreadsheet from your data', status: 'available', detail: 'Real CSV output. XLSX export needs an Office library that is not installed.' },
    { id: 'code.write', studio: 'code', label: 'Write, explain or debug code', status: env.groq ? 'available' : 'provider_required', detail: env.groq ? 'Text only — generated code is never executed on the server.' : 'Requires the Groq key on the server.' },
    { id: 'content.write', studio: 'writing', label: 'Captions, articles, scripts, hashtags, slogans', status: env.groq ? 'available' : 'provider_required', detail: env.groq ? 'Published content still goes through pre-publication moderation.' : 'Requires the Groq key on the server.' },
  ];
}

/* -------------------------------- schema --------------------------------- */

export function ensureCreativeSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS creative_items (
      id              TEXT PRIMARY KEY,
      owner_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      studio          TEXT NOT NULL,
      kind            TEXT NOT NULL,
      title           TEXT,
      prompt          TEXT,
      op              TEXT,
      source_media_id TEXT,
      media_id        TEXT REFERENCES media(id) ON DELETE SET NULL,
      text_output     TEXT,
      mime            TEXT,
      bytes           INTEGER,
      status          TEXT NOT NULL DEFAULT 'ready',
      meta            TEXT,
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_creative_owner ON creative_items(owner_id, created_at DESC);
  `);
}

/* ------------------------------- utilities -------------------------------- */

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: RUN_TIMEOUT, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const failure = new Error(stderr?.trim() || err.message || `${bin} failed`);
        failure.status = 422;
        failure.detail = stderr;
        return reject(failure);
      }
      resolve({ stdout, stderr });
    });
  });
}

function bad(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function int(value, { min, max, fallback = null, name }) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw bad(`${name} must be a number.`);
  const rounded = Math.round(parsed);
  if (rounded < min || rounded > max) throw bad(`${name} must be between ${min} and ${max}.`);
  return rounded;
}

function outputPath(ext) {
  return path.join(UPLOAD_DIR, `${uid('out_')}.${ext}`);
}

function insertMedia({ ownerId, kind, mime, absPath }) {
  const buf = fs.readFileSync(absPath);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const id = uid('med_');
  db.prepare(
    'INSERT INTO media (id, owner_id, kind, mime, size, path, sha256, encrypted, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(id, ownerId, kind, mime, buf.length, path.basename(absPath), hash, 0, now());
  return db.prepare('SELECT * FROM media WHERE id = ?').get(id);
}

/** Record a studio result. `media` may be null for text-only results. */
export function recordItem({ ownerId, studio, kind, title, prompt, op, sourceMediaId, media, textOutput, meta }) {
  ensureCreativeSchema();
  const id = uid('cr_');
  db.prepare(
    `INSERT INTO creative_items (id, owner_id, studio, kind, title, prompt, op, source_media_id, media_id, text_output, mime, bytes, status, meta, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, ownerId, studio, kind, title || null, prompt || null, op || null,
    sourceMediaId || null, media?.id || null, textOutput || null,
    media?.mime || null, media?.size || null, 'ready',
    meta ? JSON.stringify(meta) : null, now()
  );
  return db.prepare('SELECT * FROM creative_items WHERE id = ?').get(id);
}

export function serializeItem(row) {
  return {
    id: row.id,
    studio: row.studio,
    kind: row.kind,
    title: row.title,
    prompt: row.prompt,
    op: row.op,
    mediaId: row.media_id,
    mediaUrl: row.media_id ? `/api/media/${row.media_id}` : null,
    text: row.text_output,
    mime: row.mime,
    bytes: row.bytes,
    status: row.status,
    meta: row.meta ? JSON.parse(row.meta) : null,
    createdAt: row.created_at,
  };
}

/* ------------------------------- image edit ------------------------------- */

/**
 * Apply a bounded, whitelisted set of ImageMagick operations to an existing image.
 * Returns a new file; the source media row is never touched.
 */
export async function editImage({ inputPath, ops = {}, ext: requestedExt }) {
  if (!hasBinary('convert')) throw bad('Image editing is not available in this environment.', 503);

  const args = [inputPath];
  const applied = [];

  const resize = ops.resize;
  if (resize) {
    const w = int(resize.width, { min: 16, max: MAX_EDGE, name: 'width' });
    const h = int(resize.height, { min: 16, max: MAX_EDGE, name: 'height' });
    if (!w && !h) throw bad('Give a width or a height to resize.');
    args.push('-resize', `${w || ''}x${h || ''}`);
    applied.push(`resize ${w || 'auto'}x${h || 'auto'}`);
  }

  if (ops.crop) {
    const w = int(ops.crop.width, { min: 8, max: MAX_EDGE, name: 'crop width' });
    const h = int(ops.crop.height, { min: 8, max: MAX_EDGE, name: 'crop height' });
    const x = int(ops.crop.x, { min: 0, max: MAX_EDGE, fallback: 0, name: 'crop x' });
    const y = int(ops.crop.y, { min: 0, max: MAX_EDGE, fallback: 0, name: 'crop y' });
    if (!w || !h) throw bad('Crop needs a width and a height.');
    args.push('-crop', `${w}x${h}+${x}+${y}`, '+repage');
    applied.push(`crop ${w}x${h} at ${x},${y}`);
  }

  if (ops.rotate !== undefined && ops.rotate !== null && ops.rotate !== '') {
    const deg = int(ops.rotate, { min: -360, max: 360, name: 'rotation' });
    args.push('-rotate', String(deg));
    applied.push(`rotate ${deg}°`);
  }

  if (ops.grayscale) {
    args.push('-colorspace', 'Gray');
    applied.push('grayscale');
  }

  if (ops.brightness !== undefined && ops.brightness !== null && ops.brightness !== '') {
    const brightness = int(ops.brightness, { min: 40, max: 200, name: 'brightness' });
    args.push('-modulate', `${brightness},100,100`);
    applied.push(`brightness ${brightness}%`);
  }

  if (ops.saturation !== undefined && ops.saturation !== null && ops.saturation !== '') {
    const saturation = int(ops.saturation, { min: 0, max: 300, name: 'saturation' });
    args.push('-modulate', `100,${saturation},100`);
    applied.push(`saturation ${saturation}%`);
  }

  const contrast = int(ops.contrast, { min: 0, max: 3, fallback: 0, name: 'contrast' });
  for (let i = 0; i < contrast; i += 1) args.push('-contrast');
  if (contrast) applied.push(`contrast +${contrast}`);

  if (ops.text && String(ops.text).trim()) {
    const text = String(ops.text).slice(0, 200);
    const size = int(ops.textSize, { min: 10, max: 200, fallback: 42, name: 'text size' });
    const gravity = ['north', 'center', 'south'].includes(ops.gravity) ? ops.gravity : 'south';
    const colour = /^#[0-9a-fA-F]{6}$/.test(ops.textColor || '') ? ops.textColor : '#ffffff';
    args.push('-gravity', gravity, '-pointsize', String(size), '-fill', colour, '-annotate', '+0+24', text);
    applied.push('caption text');
  }

  if (!applied.length) throw bad('Choose at least one change to apply.');

  const sourceExt = path.extname(inputPath).replace('.', '').toLowerCase();
  const ext = ['png', 'jpg', 'jpeg', 'webp'].includes(requestedExt || '') ? requestedExt : (sourceExt || 'png');
  const target = outputPath(ext === 'jpeg' ? 'jpg' : ext);
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

  if (ext !== 'png') args.push('-background', 'white', '-alpha', 'remove', '-alpha', 'off');
  args.push('-quality', '88', target);

  await run('convert', args);
  if (!fs.existsSync(target) || fs.statSync(target).size === 0) throw bad('The image could not be produced.', 422);
  return { absPath: target, mime, applied, ext };
}

/* ------------------------------- audio / video ---------------------------- */

const AUDIO_EXT = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac' };

export async function editAudio({ inputPath, ops = {} }) {
  if (!hasBinary('ffmpeg')) throw bad('Audio editing is not available in this environment.', 503);
  const args = [];
  const start = ops.start !== undefined && ops.start !== '' ? Math.max(0, Number(ops.start) || 0) : null;
  const end = ops.end !== undefined && ops.end !== '' ? Number(ops.end) : null;
  if (start !== null) args.push('-ss', String(start));
  if (end !== null && end > (start || 0)) args.push('-to', String(end));
  args.push('-i', inputPath);

  const applied = [];
  if (start !== null) applied.push(`start ${start}s`);
  if (end !== null) applied.push(`end ${end}s`);

  const volume = ops.volume !== undefined && ops.volume !== '' ? int(ops.volume, { min: 0, max: 400, name: 'volume' }) : null;
  if (volume !== null) { args.push('-af', `volume=${(volume / 100).toFixed(2)}`); applied.push(`volume ${volume}%`); }

  const format = AUDIO_EXT[ops.format] ? ops.format : 'mp3';
  const target = outputPath(format);
  args.push('-c:a', format === 'mp3' ? 'libmp3lame' : format === 'wav' ? 'pcm_s16le' : 'aac', '-y', target);
  if (!applied.length) throw bad('Choose a trim point or a volume change.');

  await run('ffmpeg', args);
  if (!fs.existsSync(target) || fs.statSync(target).size === 0) throw bad('The audio could not be produced.', 422);
  return { absPath: target, mime: AUDIO_EXT[format], applied };
}

export async function editVideo({ inputPath, ops = {} }) {
  if (!hasBinary('ffmpeg')) throw bad('Video editing is not available in this environment.', 503);
  const mode = ops.mode === 'thumbnail' ? 'thumbnail' : 'trim';
  const target = mode === 'thumbnail' ? outputPath('jpg') : outputPath('mp4');

  if (mode === 'thumbnail') {
    const at = Math.max(0, Number(ops.at) || 1);
    await run('ffmpeg', ['-ss', String(at), '-i', inputPath, '-frames:v', '1', '-vf', 'scale=640:-1', '-y', target]);
    if (!fs.existsSync(target) || fs.statSync(target).size === 0) throw bad('No frame could be extracted.', 422);
    return { absPath: target, mime: 'image/jpeg', applied: [`thumbnail at ${at}s`] };
  }

  const start = Math.max(0, Number(ops.start) || 0);
  const end = Number(ops.end);
  if (!Number.isFinite(end) || end <= start) throw bad('Give an end time later than the start time.');
  const args = ['-ss', String(start), '-to', String(end), '-i', inputPath];
  if (ops.mute) args.push('-an');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-movflags', '+faststart', '-y', target);
  await run('ffmpeg', args);
  if (!fs.existsSync(target) || fs.statSync(target).size === 0) throw bad('The clip could not be produced.', 422);
  return { absPath: target, mime: 'video/mp4', applied: [`trim ${start}s–${end}s`] };
}

export async function transcribeAudio({ inputPath, filename, language }) {
  if (!groqConfigured()) throw bad('Transcription needs the Groq key on the server.', 503);
  const buffer = fs.readFileSync(inputPath);
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename || path.basename(inputPath));
  form.append('model', process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3');
  if (language) form.append('language', String(language).slice(0, 8));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw bad(`Transcription failed (${res.status}). ${body.slice(0, 200)}`, 502);
    }
    const data = await res.json();
    return { text: String(data.text || '').trim(), provider: 'groq', model: form.get('model') };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------- documents -------------------------------- */

const DOC_TYPES = {
  md: { mime: 'text/markdown', ext: 'md' },
  txt: { mime: 'text/plain', ext: 'txt' },
  csv: { mime: 'text/csv', ext: 'csv' },
  html: { mime: 'text/html', ext: 'html' },
};

export function createDocument({ format, title, content }) {
  const spec = DOC_TYPES[format];
  if (!spec) throw bad('Supported document formats are Markdown, text, CSV and HTML.');
  const body = String(content || '');
  if (!body.trim()) throw bad('There is no content to write.');
  if (body.length > 400000) throw bad('That document is too large (400,000 character limit).');

  const target = outputPath(spec.ext);
  const heading = title ? `# ${title}\n\n` : '';
  const payload = format === 'md' ? `${heading}${body}` : format === 'txt' ? `${title ? `${title}\n\n` : ''}${body}` : body;
  fs.writeFileSync(target, payload, 'utf8');
  return { absPath: target, mime: spec.mime, bytes: Buffer.byteLength(payload) };
}

export function createSpreadsheet({ title, rows }) {
  if (!Array.isArray(rows) || !rows.length) throw bad('Provide rows to build the spreadsheet.');
  const clean = rows.slice(0, 5000).map((row) => {
    const cells = Array.isArray(row) ? row : [row];
    return cells.map((cell) => {
      const value = String(cell ?? '');
      return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    }).join(',');
  });
  const target = outputPath('csv');
  fs.writeFileSync(target, `${clean.join('\n')}\n`, 'utf8');
  return { absPath: target, mime: 'text/csv', bytes: Buffer.byteLength(clean.join('\n')) };
}
