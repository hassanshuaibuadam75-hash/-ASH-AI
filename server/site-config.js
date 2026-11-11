// #ash Mesh — site configuration model for the Founder AI App Editor.
//
// Pure functions only: the editable registry, safe defaults, strict validation of a
// proposed change and human-readable summaries. No database, no network, no AI provider.
//
// Why this layer exists: the Founder edits the *running application* through #ash AI.
// A chat message can never rewrite source files, so an edit is expressed as a validated
// change to this configuration document, which the client renders (theme tokens and page
// slots). Every path — AI proposal, Founder UI, automated test — goes through the same
// validation, so an AI reply cannot smuggle in arbitrary CSS, HTML or an unknown page.

export const PAGE_KEYS = [
  'home',
  'market',
  'academy',
  'heritage',
  'messages',
  'profile',
  'settings',
  'support',
  'friends',
  'notifications',
  'ai',
];

// Each page exposes a small, explicit set of editable slots. Anything not listed here
// cannot be changed by a proposal.
export const PAGES = {
  home: { label: 'Home feed', fields: ['heading', 'subheading'] },
  market: { label: 'Marketplace', fields: ['heading', 'subheading'] },
  academy: { label: '#ash Academy', fields: ['heading', 'subheading'] },
  heritage: { label: '#ash Heritage', fields: ['heading', 'subheading'] },
  messages: { label: 'Messages', fields: ['heading', 'subheading'] },
  profile: { label: 'Profiles', fields: ['heading', 'subheading'] },
  settings: { label: 'Settings', fields: ['heading', 'subheading'] },
  support: { label: 'Menu & support', fields: ['heading', 'subheading'] },
  friends: { label: 'Friends', fields: ['heading', 'subheading'] },
  notifications: { label: 'Notifications', fields: ['heading', 'subheading'] },
  ai: { label: '#ash AI', fields: ['heading', 'subheading'] },
};

export const FIELD_LABELS = { heading: 'Heading', subheading: 'Description' };

export const TEXT_LIMITS = {
  heading: 120,
  subheading: 240,
  sectionTitle: 80,
  sectionBody: 1200,
  ctaLabel: 40,
  ctaHref: 120,
};

// Theme tokens map onto the CSS variables the existing design system already uses, so a
// change here restyles the real interface instead of a mock preview.
export const THEME_KEYS = {
  accent: { label: 'Accent colour', type: 'color' },
  accentSoft: { label: 'Secondary accent', type: 'color' },
  bg: { label: 'Background', type: 'color' },
  surface: { label: 'Card surface', type: 'color' },
  text: { label: 'Body text', type: 'color' },
  muted: { label: 'Muted text', type: 'color' },
  font: { label: 'Typography', type: 'font' },
  radius: { label: 'Corner radius', type: 'radius' },
};

// Allow-listed font stacks: a proposal can choose a style, never inject CSS.
export const FONTS = {
  system: "'Inter', 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "'SFMono-Regular', ui-monospace, Menlo, Consolas, monospace",
  rounded: "'Nunito', 'Segoe UI', system-ui, sans-serif",
};

export const MAX_SECTIONS_PER_PAGE = 8;
export const MAX_CHANGES_PER_PROPOSAL = 12;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const HREF = /^\/[A-Za-z0-9/_?=&-]*$/;

export function defaultPage() {
  return { heading: '', subheading: '', sections: [] };
}

export function defaultConfig() {
  const pages = {};
  for (const key of PAGE_KEYS) pages[key] = defaultPage();
  return {
    theme: {
      accent: '#35ff8b',
      accentSoft: '#1fbd63',
      bg: '#070b08',
      surface: '#0c1710',
      text: '#eaf6ee',
      muted: '#93a99b',
      font: 'system',
      radius: 18,
    },
    pages,
  };
}

/** Remove control characters and markup from free text, collapse noise, cap the length. */
export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function cleanHref(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  return HREF.test(text) ? text.slice(0, TEXT_LIMITS.ctaHref) : '';
}

function newSectionId() {
  return `sec_${Math.random().toString(36).slice(2, 9)}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isColor(value) {
  return typeof value === 'string' && HEX.test(value.trim());
}

function pageOf(config, key) {
  if (!config.pages[key]) config.pages[key] = defaultPage();
  if (!Array.isArray(config.pages[key].sections)) config.pages[key].sections = [];
  return config.pages[key];
}

/** Apply one already-validated operation to a config object (mutates the passed clone). */
function applyOp(config, op) {
  if (op.op === 'set_theme') {
    config.theme[op.key] = op.value;
    return;
  }
  const page = pageOf(config, op.page);
  if (op.op === 'set_text') {
    page[op.field] = op.value;
    return;
  }
  if (op.op === 'reset_page') {
    config.pages[op.page] = defaultPage();
    return;
  }
  if (op.op === 'add_section') {
    page.sections.push({
      id: op.id,
      title: op.title,
      body: op.body,
      ctaLabel: op.ctaLabel,
      ctaHref: op.ctaHref,
    });
    return;
  }
  if (op.op === 'update_section') {
    const section = page.sections.find((s) => s.id === op.sectionId);
    if (section) {
      if (op.title !== undefined) section.title = op.title;
      if (op.body !== undefined) section.body = op.body;
      if (op.ctaLabel !== undefined) section.ctaLabel = op.ctaLabel;
      if (op.ctaHref !== undefined) section.ctaHref = op.ctaHref;
    }
    return;
  }
  if (op.op === 'remove_section') {
    page.sections = page.sections.filter((s) => s.id !== op.sectionId);
  }
}

function validateThemeValue(key, value) {
  const meta = THEME_KEYS[key];
  if (meta.type === 'color') {
    if (!isColor(value)) return { error: `${meta.label} must be a hex colour such as #35ff8b.` };
    return { value: value.trim().toLowerCase() };
  }
  if (meta.type === 'font') {
    if (!Object.prototype.hasOwnProperty.call(FONTS, value)) {
      return { error: `${meta.label} must be one of: ${Object.keys(FONTS).join(', ')}.` };
    }
    return { value };
  }
  if (meta.type === 'radius') {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 32) return { error: `${meta.label} must be between 0 and 32.` };
    return { value: Math.round(n) };
  }
  return { error: 'Unknown design setting.' };
}

/**
 * Validate a list of proposed operations against the current configuration.
 * Returns { ok: true, ops, config } where `config` is the resulting (preview) document,
 * or { ok: false, error } with a Founder-readable reason.
 */
export function validateChanges(changes, baseConfig) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return { ok: false, error: 'No changes were proposed.' };
  }
  if (changes.length > MAX_CHANGES_PER_PROPOSAL) {
    return { ok: false, error: `A single proposal may contain at most ${MAX_CHANGES_PER_PROPOSAL} changes.` };
  }

  const working = clone(baseConfig || defaultConfig());
  const ops = [];

  for (const raw of changes) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'A change entry was not an object.' };
    const op = cleanText(raw.op, 32);

    if (op === 'set_theme') {
      const key = cleanText(raw.key, 32);
      if (!Object.prototype.hasOwnProperty.call(THEME_KEYS, key)) {
        return { ok: false, error: `Unknown design setting “${key}”. Allowed: ${Object.keys(THEME_KEYS).join(', ')}.` };
      }
      const checked = validateThemeValue(key, raw.value);
      if (checked.error) return { ok: false, error: checked.error };
      const entry = { op: 'set_theme', key, value: checked.value };
      ops.push(entry);
      applyOp(working, entry);
      continue;
    }

    const page = cleanText(raw.page, 32);
    if (!Object.prototype.hasOwnProperty.call(PAGES, page)) {
      return { ok: false, error: `Unknown page “${page}”. Allowed pages: ${PAGE_KEYS.join(', ')}.` };
    }
    const pageLabel = PAGES[page].label;

    if (op === 'set_text') {
      const field = cleanText(raw.field, 32);
      if (!PAGES[page].fields.includes(field)) {
        return { ok: false, error: `${pageLabel} has no editable “${field}” field.` };
      }
      const value = cleanText(raw.value, TEXT_LIMITS[field]);
      const entry = { op: 'set_text', page, field, value };
      ops.push(entry);
      applyOp(working, entry);
      continue;
    }

    if (op === 'reset_page') {
      const entry = { op: 'reset_page', page };
      ops.push(entry);
      applyOp(working, entry);
      continue;
    }

    if (op === 'add_section') {
      const target = pageOf(working, page);
      if (target.sections.length >= MAX_SECTIONS_PER_PAGE) {
        return { ok: false, error: `${pageLabel} already has the maximum of ${MAX_SECTIONS_PER_PAGE} added sections.` };
      }
      const entry = {
        op: 'add_section',
        page,
        id: newSectionId(),
        title: cleanText(raw.title, TEXT_LIMITS.sectionTitle),
        body: cleanText(raw.body, TEXT_LIMITS.sectionBody),
        ctaLabel: cleanText(raw.ctaLabel, TEXT_LIMITS.ctaLabel),
        ctaHref: cleanHref(raw.ctaHref),
      };
      if (!entry.title && !entry.body) return { ok: false, error: 'A new section needs a title or some text.' };
      if (entry.ctaLabel && !entry.ctaHref) entry.ctaHref = '/';
      ops.push(entry);
      applyOp(working, entry);
      continue;
    }

    if (op === 'update_section' || op === 'remove_section') {
      const sectionId = cleanText(raw.sectionId, 40);
      const target = pageOf(working, page);
      const exists = target.sections.some((s) => s.id === sectionId);
      if (!exists) return { ok: false, error: `${pageLabel} has no section with that id.` };
      if (op === 'remove_section') {
        const entry = { op: 'remove_section', page, sectionId };
        ops.push(entry);
        applyOp(working, entry);
        continue;
      }
      const entry = { op: 'update_section', page, sectionId };
      if (raw.title !== undefined) entry.title = cleanText(raw.title, TEXT_LIMITS.sectionTitle);
      if (raw.body !== undefined) entry.body = cleanText(raw.body, TEXT_LIMITS.sectionBody);
      if (raw.ctaLabel !== undefined) entry.ctaLabel = cleanText(raw.ctaLabel, TEXT_LIMITS.ctaLabel);
      if (raw.ctaHref !== undefined) entry.ctaHref = cleanHref(raw.ctaHref);
      ops.push(entry);
      applyOp(working, entry);
      continue;
    }

    return { ok: false, error: `Unknown operation “${op}”.` };
  }

  return { ok: true, ops, config: working };
}

/** Re-apply stored operations to a (possibly newer) base configuration. */
export function applyOps(baseConfig, ops) {
  const working = clone(baseConfig || defaultConfig());
  for (const op of ops) applyOp(working, op);
  return working;
}

/** Human-readable change log lines for a proposal or a version. */
export function describeChanges(ops) {
  const lines = [];
  for (const op of ops) {
    if (op.op === 'set_theme') {
      const meta = THEME_KEYS[op.key];
      lines.push(`Design · ${meta ? meta.label : op.key} set to ${op.value}`);
      continue;
    }
    const pageLabel = PAGES[op.page] ? PAGES[op.page].label : op.page;
    if (op.op === 'set_text') {
      const preview = op.value ? `“${op.value.length > 60 ? `${op.value.slice(0, 57)}…` : op.value}”` : 'cleared';
      lines.push(`${pageLabel} · ${FIELD_LABELS[op.field] || op.field} ${preview}`);
      continue;
    }
    if (op.op === 'reset_page') {
      lines.push(`${pageLabel} · restored to the built-in layout`);
      continue;
    }
    if (op.op === 'add_section') {
      lines.push(`${pageLabel} · new section “${op.title || 'Untitled'}”${op.ctaLabel ? ` with button “${op.ctaLabel}”` : ''}`);
      continue;
    }
    if (op.op === 'update_section') {
      lines.push(`${pageLabel} · section updated`);
      continue;
    }
    if (op.op === 'remove_section') {
      lines.push(`${pageLabel} · section removed`);
    }
  }
  return lines;
}

/** Pages touched by a set of operations, used to point the Founder at the preview. */
export function touchedPages(ops) {
  const pages = new Set();
  for (const op of ops) {
    if (op.page) pages.add(op.page);
  }
  return [...pages];
}

/** Defensive read of a configuration document coming from storage. */
export function sanitizeConfig(raw) {
  const base = defaultConfig();
  if (!raw || typeof raw !== 'object') return base;
  const theme = raw.theme && typeof raw.theme === 'object' ? raw.theme : {};
  for (const key of Object.keys(THEME_KEYS)) {
    const checked = validateThemeValue(key, theme[key]);
    if (!checked.error) base.theme[key] = checked.value;
  }
  const pages = raw.pages && typeof raw.pages === 'object' ? raw.pages : {};
  for (const key of PAGE_KEYS) {
    const page = pages[key];
    if (!page || typeof page !== 'object') continue;
    base.pages[key].heading = cleanText(page.heading, TEXT_LIMITS.heading);
    base.pages[key].subheading = cleanText(page.subheading, TEXT_LIMITS.subheading);
    if (Array.isArray(page.sections)) {
      base.pages[key].sections = page.sections.slice(0, MAX_SECTIONS_PER_PAGE).map((s) => ({
        id: cleanText(s?.id, 40) || newSectionId(),
        title: cleanText(s?.title, TEXT_LIMITS.sectionTitle),
        body: cleanText(s?.body, TEXT_LIMITS.sectionBody),
        ctaLabel: cleanText(s?.ctaLabel, TEXT_LIMITS.ctaLabel),
        ctaHref: cleanHref(s?.ctaHref),
      }));
    }
  }
  return base;
}

/** Registry handed to the AI and to the Founder UI so both know what is editable. */
export function editorRegistry() {
  return {
    pages: PAGE_KEYS.map((key) => ({
      page: key,
      label: PAGES[key].label,
      fields: PAGES[key].fields,
      maxSections: MAX_SECTIONS_PER_PAGE,
    })),
    theme: Object.entries(THEME_KEYS).map(([key, meta]) => ({
      key,
      label: meta.label,
      type: meta.type,
      ...(meta.type === 'font' ? { options: Object.keys(FONTS) } : {}),
      ...(meta.type === 'radius' ? { min: 0, max: 32 } : {}),
    })),
    operations: [
      { op: 'set_text', args: ['page', 'field', 'value'] },
      { op: 'add_section', args: ['page', 'title', 'body', 'ctaLabel?', 'ctaHref?'] },
      { op: 'update_section', args: ['page', 'sectionId', 'title?', 'body?'] },
      { op: 'remove_section', args: ['page', 'sectionId'] },
      { op: 'reset_page', args: ['page'] },
      { op: 'set_theme', args: ['key', 'value'] },
    ],
    limits: TEXT_LIMITS,
  };
}

/** Extract the first JSON object from model output (fenced block or bare braces). */
export function extractJson(text) {
  const source = String(text || '');
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(source);

  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i += 1) {
      const ch = candidate[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}
