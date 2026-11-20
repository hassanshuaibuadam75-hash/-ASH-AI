// #ash Mesh — AI provider gate.
//
// ONE rule enforced here: a paid provider is never called unless the Founder has approved
// a spending limit, and a credential that a provider has already rejected is never retried
// automatically. Everything else in the application asks this module instead of reading
// process.env directly, so there is a single place to audit.
//
// SECURITY CONTRACT
//   * Keys are read from process.env only, inside this module and the two adapters.
//   * No key, key fragment or hash of a key is ever returned to a client. The cached
//     OpenRouter state stores only a SHA-256 fingerprint so a rotated key is detectable
//     without keeping the secret on disk.
//   * Nothing here spends money. runReplicate() refuses before it opens a socket.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';

const STATUS_FILE = path.join(DATA_DIR, 'provider-status.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/* --------------------------------- errors --------------------------------- */

export class ProviderDisabledError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'ProviderDisabledError';
    this.status = 503;
    this.code = 'provider_disabled';
    this.reason = reason;
  }
}

/* -------------------------------- Replicate -------------------------------- */

export function replicateConfigured() {
  return !!process.env.REPLICATE_API_KEY;
}

/**
 * Paid generation needs BOTH an explicit approval flag and a positive spending cap.
 * Two independent values must be set, so a half-configured environment stays disabled.
 */
export function replicateApproval() {
  const flag = String(process.env.REPLICATE_GENERATION_APPROVED || '').trim().toLowerCase();
  const approvedFlag = ['1', 'true', 'yes', 'approved'].includes(flag);
  const cap = Number(process.env.REPLICATE_SPEND_CAP_USD || 0);
  const hasCap = Number.isFinite(cap) && cap > 0;
  const approved = approvedFlag && hasCap;
  return {
    approved,
    spendCapUsd: approved ? cap : 0,
    configured: replicateConfigured(),
    reason: !replicateConfigured()
      ? 'replicate_not_configured'
      : !approvedFlag
        ? 'approval_flag_missing'
        : !hasCap
          ? 'spend_cap_missing'
          : 'approved',
  };
}

/**
 * Throws before any network call. This is the guard every generation route must use.
 * Order matters: the most useful, most honest reason is reported first.
 */
export function assertPaidGenerationAllowed() {
  if (!replicateConfigured()) {
    throw new ProviderDisabledError(
      'Image, video and music generation need a provider key. No provider is configured on this deployment, so nothing was generated.',
      'replicate_not_configured'
    );
  }
  const approval = replicateApproval();
  if (!approval.approved) {
    throw new ProviderDisabledError(
      'Paid generation is disabled on this deployment. Replicate is configured, but no spending limit has been approved, so no credits are spent and no output is produced. The Founder can enable it by setting REPLICATE_GENERATION_APPROVED=1 together with a positive REPLICATE_SPEND_CAP_USD.',
      approval.reason
    );
  }
}

/* -------------------------------- OpenRouter ------------------------------- */

export function openrouterConfigured() {
  return !!process.env.OPENROUTER_API_KEY;
}

function keyFingerprint() {
  const key = process.env.OPENROUTER_API_KEY || '';
  if (!key) return null;
  // A short fingerprint is enough to notice a rotated key and is not reversible.
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function readCache() {
  try {
    const raw = fs.readFileSync(STATUS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeCache(patch) {
  try {
    const next = { ...readCache(), ...patch };
    fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch {
    // A read-only data directory must not break the request path; the cache is an
    // optimisation, not a source of truth.
  }
}

/**
 * Current OpenRouter state.
 *
 * verify:false (the default) NEVER performs a network request. That is what the capability
 * registry and the UI use, so a rejected key cannot be hammered by page loads.
 *
 * verify:true performs at most one check per cached result and stores the outcome for 24h.
 * A key that the provider already rejected is therefore retried at most once per day, and
 * only when a caller explicitly asks for verification.
 */
export async function openrouterStatus({ verify = false, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (!openrouterConfigured()) {
    return { provider: 'openrouter', state: 'not_configured', checkedAt: null, note: 'No OPENROUTER_API_KEY is set on the server.' };
  }

  const fingerprint = keyFingerprint();
  const cached = readCache().openrouter;
  const fresh = cached && cached.fingerprint === fingerprint && now - Date.parse(cached.checkedAt || 0) < CACHE_TTL_MS;

  if (fresh) return { ...cached, provider: 'openrouter' };

  if (cached && cached.fingerprint !== fingerprint) {
    // The key changed since the last check: the old verdict no longer applies.
    return {
      provider: 'openrouter',
      state: 'unverified',
      checkedAt: null,
      note: 'A new OpenRouter key is configured but has not been verified yet. It is checked once, on demand.',
    };
  }

  if (!verify) {
    return {
      provider: 'openrouter',
      state: 'unverified',
      checkedAt: null,
      note: 'An OpenRouter key is configured but not verified. Verification runs once, on demand — it is not retried automatically.',
    };
  }

  let state = 'unreachable';
  let note = 'The OpenRouter key could not be verified because the provider could not be reached.';
  let limit = null;

  try {
    const res = await fetchImpl('https://openrouter.ai/api/v1/key', {
      method: 'GET',
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      state = 'ok';
      note = 'The OpenRouter key is accepted by the provider.';
      limit = body?.data?.limit ?? null;
    } else if (res.status === 401 || res.status === 403) {
      state = 'invalid';
      note = 'OpenRouter rejected this key (401/403). Replace OPENROUTER_API_KEY with a working key; it is not retried automatically.';
    } else if (res.status === 429) {
      state = 'rate_limited';
      note = 'OpenRouter is rate-limiting key checks. Try again later.';
    } else {
      state = 'unreachable';
      note = `OpenRouter returned HTTP ${res.status} while checking the key.`;
    }
  } catch {
    state = 'unreachable';
  }

  const record = { provider: 'openrouter', state, note, limit, checkedAt: new Date(now).toISOString(), fingerprint };
  writeCache({ openrouter: record });
  return record;
}

/** The cached verdict only — never touches the network. */
export function openrouterCachedStatus() {
  if (!openrouterConfigured()) {
    return { provider: 'openrouter', state: 'not_configured', checkedAt: null, note: 'No OPENROUTER_API_KEY is set on the server.' };
  }
  const cached = readCache().openrouter;
  if (cached && cached.fingerprint === keyFingerprint()) return { ...cached, provider: 'openrouter' };
  return {
    provider: 'openrouter',
    state: 'unverified',
    checkedAt: null,
    note: 'An OpenRouter key is configured but not verified. Verification runs once, on demand — it is not retried automatically.',
  };
}

/** True only when OpenRouter is known to accept the configured key. */
export function openrouterUsable() {
  return openrouterCachedStatus().state === 'ok';
}

/* ------------------------------- Groq (fallback) ---------------------------- */

export function groqReady() {
  return !!process.env.GROQ_API_KEY;
}

/* ------------------------------ consolidated ------------------------------- */

/**
 * Everything the UI and the capability registry need, with no secrets.
 * `paidInferenceEnabled` is false on every zero-cost deployment.
 */
export function providerReport() {
  const approval = replicateApproval();
  return {
    groq: {
      provider: 'groq',
      configured: groqReady(),
      role: 'working fallback for text, writing, translation, slides and speech-to-text',
      paid: false,
    },
    replicate: {
      provider: 'replicate',
      configured: replicateConfigured(),
      paid: true,
      approvalRequired: true,
      approval,
      generationEnabled: approval.approved,
      note: approval.approved
        ? `Paid generation is approved with a $${approval.spendCapUsd} spending cap.`
        : 'Configured but disabled: no credits are spent until a spending limit is approved.',
    },
    openrouter: openrouterCachedStatus(),
    paidInferenceEnabled: approval.approved,
  };
}
