// #ash Mesh — Replicate adapter (paid generation).
//
// ZERO-COST CONTRACT
//   * runReplicate() calls assertPaidGenerationAllowed() FIRST. On a deployment without an
//     approved spending cap it throws ProviderDisabledError before any socket is opened, so
//     no prediction, no credit and no billing event can occur.
//   * fetchImpl is injectable so tests can prove that no request is made while disabled.
//
// The curated model list below is a routing table, not a promise. Each entry is marked
// slugVerified:false because Replicate's /v1/models listing ignores its query parameter and
// returned the same page for every term, so slugs could not be confirmed through the API.
// The Founder must confirm a slug (and its price) before enabling paid generation.
import { assertPaidGenerationAllowed, ProviderDisabledError, replicateApproval, replicateConfigured } from './providers.js';

const PREDICTIONS_URL = 'https://api.replicate.com/v1/predictions';

/** Curated routing table. `paid` is true for every entry: Replicate bills per run. */
export const REPLICATE_MODELS = [
  {
    id: 'image.generate',
    studio: 'image',
    label: 'Text to image',
    slug: 'black-forest-labs/flux-schnell',
    output: 'image',
    paid: true,
    slugVerified: false,
    note: 'Fast, low-cost image model. Price per run must be confirmed on Replicate before approval.',
  },
  {
    id: 'image.edit',
    studio: 'image',
    label: 'Instruction-based image editing',
    slug: 'black-forest-labs/flux-kontext-pro',
    output: 'image',
    paid: true,
    slugVerified: false,
    note: 'Only used when paid generation is approved; local ImageMagick editing needs no credits.',
  },
  {
    id: 'video.generate',
    studio: 'video',
    label: 'Text or image to video',
    slug: 'minimax/video-01',
    output: 'video',
    paid: true,
    slugVerified: false,
    note: 'Video runs are the most expensive class of call; a per-run cap is strongly recommended.',
  },
  {
    id: 'audio.music',
    studio: 'audio',
    label: 'Generate original music',
    slug: 'meta/musicgen',
    output: 'audio',
    paid: true,
    slugVerified: false,
    note: 'Output must be original audio; copyrighted material must not be requested or produced.',
  },
];

export function replicateModelsFor(capabilityId) {
  return REPLICATE_MODELS.filter((model) => model.id === capabilityId);
}

/** Credentials and approval summary with no secret material. */
export function replicateReadiness() {
  return {
    configured: replicateConfigured(),
    approval: replicateApproval(),
    models: REPLICATE_MODELS.map((model) => ({ ...model })),
  };
}

/** Remove anything credential-shaped from provider text before it can be surfaced. */
export function redactReplicate(value) {
  let text = String(value == null ? '' : value);
  const key = process.env.REPLICATE_API_KEY;
  if (key && key.length >= 8) text = text.split(key).join('[redacted]');
  return text
    .replace(/r8_[A-Za-z0-9]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]');
}

export class ReplicateError extends Error {
  constructor(kind, message, status = 502, detail) {
    super(message);
    this.name = 'ReplicateError';
    this.kind = kind;
    this.status = status;
    this.detail = detail ? redactReplicate(detail) : undefined;
  }
}

/**
 * Create and await a prediction.
 * Refuses before the network call unless paid generation is explicitly approved.
 */
export async function runReplicate({
  capabilityId,
  input = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = 120000,
  pollIntervalMs = 2500,
  slug,
} = {}) {
  assertPaidGenerationAllowed();

  const model = REPLICATE_MODELS.find((entry) => entry.id === capabilityId);
  const target = slug || model?.slug;
  if (!target) throw new ReplicateError('invalid_request', 'No model is selected for that capability.', 400);

  const headers = {
    Authorization: `Bearer ${process.env.REPLICATE_API_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'wait',
  };

  let created;
  try {
    created = await fetchImpl(PREDICTIONS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ version: undefined, model: target, input }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new ReplicateError(timedOut ? 'timeout' : 'network',
      timedOut ? 'The generation provider did not respond in time. No output was produced.' : 'The generation provider could not be reached.',
      timedOut ? 504 : 502, err?.message);
  }

  const raw = await created.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }

  if (!created.ok) {
    const kind = created.status === 401 || created.status === 403 ? 'unauthorized'
      : created.status === 402 ? 'payment_required'
        : created.status === 429 ? 'rate_limited' : 'upstream';
    throw new ReplicateError(kind, `The generation provider refused the request (HTTP ${created.status}). No output was produced.`,
      created.status === 429 ? 429 : 502, body?.detail || body?.title || raw.slice(0, 300));
  }

  let prediction = body;
  const deadline = Date.now() + timeoutMs;
  while (prediction && ['starting', 'processing'].includes(prediction.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const polled = await fetchImpl(prediction.urls?.get || `${PREDICTIONS_URL}/${prediction.id}`, {
      headers, signal: AbortSignal.timeout(15000),
    });
    prediction = await polled.json().catch(() => null);
  }

  if (!prediction) throw new ReplicateError('bad_response', 'The generation provider returned an unreadable response.', 502);
  if (prediction.status !== 'succeeded') {
    throw new ReplicateError('failed', `The generation run ended as "${prediction.status}". No output was produced.`, 502, prediction.error);
  }

  return {
    provider: 'replicate',
    model: target,
    output: prediction.output,
    predictionId: prediction.id,
    metrics: prediction.metrics || null,
  };
}

export { ProviderDisabledError };
