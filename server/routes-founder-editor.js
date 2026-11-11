// #ash Mesh — Founder-only application editing API.
//
// Security model:
//   * Every mutating route sits behind requireAuth + requireFounder, which re-reads the
//     caller's row (is_founder = 1 AND role = 'founder'). A username or name typed into a
//     chat message can never grant authority — identity comes from the session only.
//   * Previewing an unpublished version is Founder-only as well.
//   * A proposal is inert data. It becomes a TEST draft only when the Founder approves it,
//     and reaches LIVE only through a separate, explicit publish action.
import express from 'express';
import { badRequest, clean, rateLimit, requireAuth, requireFounder } from './lib.js';
import { FRIENDLY_ERRORS, groqChat, groqConfigured, groqErrorBody } from './ai-groq.js';
import * as editor from './site-editor.js';
import { defaultConfig, editorRegistry, extractJson } from './site-config.js';

const router = express.Router();

// Editing is a heavy, deliberate action: bounded per Founder per hour.
const editLimit = rateLimit({ name: 'founder_editor', limit: 120, windowMs: 60 * 60 * 1000 });

function isFounderRequest(req) {
  return !!req.user && req.user.is_founder === 1 && req.user.role === 'founder';
}

function versionMeta(version) {
  if (!version) return null;
  return {
    id: version.id,
    number: version.number,
    environment: version.environment,
    status: version.status,
    summary: version.summary,
    changeLog: version.changeLog,
    createdAt: version.createdAt,
    testedAt: version.testedAt,
    publishedAt: version.publishedAt,
    restoredFrom: version.restoredFrom,
  };
}

function handle(res, fn) {
  try {
    return fn();
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      error: err.code || 'editor_error',
      message: status === 500 ? 'The editor could not complete that action.' : err.message,
    });
  }
}

/* ------------------------- published configuration ------------------------- */

// Public: what the running client renders. Also serves a Founder-only preview of any
// stored version (?version=...) so a draft can be reviewed before it goes live.
router.get('/site-config', (req, res) => {
  const requested = clean(req.query.version, 64);

  if (requested) {
    if (!isFounderRequest(req)) {
      return res.status(403).json({
        error: 'founder_only',
        message: 'Previewing an unpublished version is limited to the Founder.',
      });
    }
    const version = editor.getVersion(requested);
    if (!version) return res.status(404).json({ error: 'not_found', message: 'That version no longer exists.' });
    return res.json({ config: version.config, version: versionMeta(version), preview: true });
  }

  const live = editor.liveVersion();
  return res.json({
    config: live ? live.config : defaultConfig(),
    version: versionMeta(live),
    preview: false,
  });
});

/* ------------------------------ founder panel ----------------------------- */

router.get('/founder/editor/status', requireAuth, requireFounder, (req, res) => {
  res.json({
    live: versionMeta(editor.liveVersion()),
    draft: versionMeta(editor.draftVersion()),
    versions: editor.listVersions(30).map(versionMeta),
    proposals: editor.listProposals(req.user.id, 10),
    events: editor.recentEvents(20),
    stats: editor.editorStats(),
    registry: editorRegistry(),
  });
});

router.get('/founder/editor/versions', requireAuth, requireFounder, (req, res) => {
  res.json({ versions: editor.listVersions(clean(req.query.limit, 10) || 50).map(versionMeta) });
});

router.get('/founder/editor/versions/:id', requireAuth, requireFounder, (req, res) => {
  const version = editor.getVersion(req.params.id);
  if (!version) return res.status(404).json({ error: 'not_found', message: 'That version no longer exists.' });
  res.json({ version });
});

router.get('/founder/editor/events', requireAuth, requireFounder, (req, res) => {
  res.json({ events: editor.recentEvents(clean(req.query.limit, 10) || 30) });
});

/* -------------------------------- proposals ------------------------------- */

function proposalWithAi(instruction) {
  if (!groqConfigured()) {
    const err = new Error(FRIENDLY_ERRORS.not_configured || 'The AI service is not configured.');
    err.status = 503;
    err.code = 'ai_not_configured';
    return Promise.reject(err);
  }

  const registry = editorRegistry();
  const current = editor.baseConfig();
  const system = [
    'You are the #ash Mesh application editor. Translate the Founder instruction into a JSON patch for the live site configuration.',
    'Reply with exactly ONE JSON object and no prose:',
    '{"site_edit": true, "summary": "<one sentence>", "changes": [<operations>]}',
    'Allowed operations:',
    '  {"op":"set_text","page":"<page>","field":"heading|subheading","value":"<text>"}',
    '  {"op":"add_section","page":"<page>","title":"<text>","body":"<text>","ctaLabel":"<text>","ctaHref":"/path"}',
    '  {"op":"update_section","page":"<page>","sectionId":"<existing id>","title":"<text>","body":"<text>"}',
    '  {"op":"remove_section","page":"<page>","sectionId":"<existing id>"}',
    '  {"op":"reset_page","page":"<page>"}',
    '  {"op":"set_theme","key":"accent|accentSoft|bg|surface|text|muted|font|radius","value":"<hex colour, font name or number>"}',
    'Pages: ' + registry.pages.map((p) => p.page).join(', ') + '.',
    'Font options: system, serif, mono, rounded.',
    'Rules: never invent pages, CSS or HTML. Keep headings under 120 characters and descriptions under 240.',
    'To remove the welcome/hero text on a page, set its heading and subheading to "".',
    'If the instruction cannot be expressed with these operations, return {"site_edit": true, "summary": "<why>", "changes": []}.',
    'Never claim a change has been applied: the Founder must approve it first.',
  ].join('\n');

  return groqChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({ instruction, current_configuration: current, editable: registry }) },
    ],
    temperature: 0.2,
    maxTokens: 1200,
  }).then((result) => {
    const text = typeof result === 'string' ? result : result && (result.text || result.content || '');
    const parsed = extractJson(text);
    if (!parsed || parsed.site_edit !== true || !Array.isArray(parsed.changes)) {
      const err = new Error('The assistant did not return a usable change. Try describing the edit more precisely.');
      err.status = 422;
      err.code = 'patch_unusable';
      throw err;
    }
    if (parsed.changes.length === 0) {
      const err = new Error(parsed.summary || 'That instruction cannot be expressed as a supported edit.');
      err.status = 422;
      err.code = 'patch_empty';
      throw err;
    }
    return { changes: parsed.changes, summary: parsed.summary };
  });
}

router.post('/founder/editor/propose', requireAuth, requireFounder, editLimit, async (req, res) => {
  const instruction = clean(req.body.instruction, 2000);
  const supplied = Array.isArray(req.body.changes) ? req.body.changes : null;
  const suppliedSummary = clean(req.body.summary, 400);

  if (!supplied && !instruction) return badRequest(res, 'Describe the change you want to make.');

  let changes = supplied;
  let summary = suppliedSummary;
  let source = 'structured';

  if (!changes) {
    source = 'ai';
    try {
      const drafted = await proposalWithAi(instruction);
      changes = drafted.changes;
      summary = summary || drafted.summary;
    } catch (err) {
      const status = err.status || 502;
      if (status === 503 || err.code === 'ai_not_configured') {
        return res.status(503).json({ error: 'ai_not_configured', message: err.message });
      }
      if (status === 422) return res.status(422).json({ error: err.code || 'patch_unusable', message: err.message });
      return res.status(status).json(groqErrorBody ? groqErrorBody(err) : { error: 'ai_error', message: err.message });
    }
  }

  return handle(res, () => {
    const proposal = editor.createProposal({ founderId: req.user.id, instruction, changes, summary, source });
    res.status(201).json({ proposal });
  });
});

router.get('/founder/editor/proposals', requireAuth, requireFounder, (req, res) => {
  res.json({ proposals: editor.listProposals(req.user.id, clean(req.query.limit, 10) || 20) });
});

router.get('/founder/editor/proposals/:id', requireAuth, requireFounder, (req, res) => {
  const proposal = editor.getProposal(req.params.id);
  if (!proposal) return res.status(404).json({ error: 'not_found', message: 'That proposal no longer exists.' });
  res.json({ proposal });
});

// Founder approval → TEST draft. The previous draft and the LIVE version are both retained.
router.post('/founder/editor/proposals/:id/apply', requireAuth, requireFounder, editLimit, (req, res) => {
  handle(res, () => {
    const result = editor.applyProposal({ proposalId: req.params.id, founderId: req.user.id });
    res.json({ ...result, live: versionMeta(editor.liveVersion()) });
  });
});

router.post('/founder/editor/proposals/:id/cancel', requireAuth, requireFounder, editLimit, (req, res) => {
  handle(res, () => {
    const proposal = editor.cancelProposal({ proposalId: req.params.id, founderId: req.user.id });
    res.json({ proposal });
  });
});

/* --------------------------- versions & rollback -------------------------- */

router.post('/founder/editor/versions/:id/tested', requireAuth, requireFounder, editLimit, (req, res) => {
  handle(res, () => {
    res.json({ version: versionMeta(editor.markTested(req.params.id, req.user.id)) });
  });
});

// Explicit, separate promotion to LIVE.
router.post('/founder/editor/versions/:id/publish', requireAuth, requireFounder, editLimit, (req, res) => {
  handle(res, () => {
    const version = editor.publishVersion(req.params.id, req.user.id);
    res.json({ version: versionMeta(version), live: versionMeta(editor.liveVersion()) });
  });
});

// Roll back: restores a previous version as a NEW version (history is never rewritten).
router.post('/founder/editor/versions/:id/restore', requireAuth, requireFounder, editLimit, (req, res) => {
  handle(res, () => {
    const publish = req.body && req.body.publish === true;
    const version = editor.restoreVersion({ versionId: req.params.id, founderId: req.user.id, publish });
    res.json({ version: versionMeta(version), live: versionMeta(editor.liveVersion()) });
  });
});

export default router;
