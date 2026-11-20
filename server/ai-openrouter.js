// #ash Mesh — OpenRouter adapter.
//
// ZERO-COST / NO-RETRY CONTRACT
//   * A key that OpenRouter already rejected is never sent again automatically. The adapter
//     reads the cached verdict from providers.js and refuses locally, so a rejected key
//     cannot be retried by page loads, capability reads or chat retries.
//   * Only an explicit verification (openrouterStatus({ verify: true })) performs a check,
//     and its result is cached for 24 hours.
//   * Provider text is redacted before it can reach a client; the key never appears in an
//     error message, a log line or a response body.
import { openrouterCachedStatus, openrouterConfigured } from './providers.js';

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

// An explicit OPENROUTER_MODEL always wins. The default is a free-tier model id; it is only
// used once the Founder's key is verified, so nothing here depends on unverified pricing.
export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';

export function redactOpenRouter(value) {
  let text = String(value == null ? '' : value);
  const key = process.env.OPENROUTER_API_KEY;
  if (key && key.length >= 8) text = text.split(key).join('[redacted]');
  return text
    .replace(/sk-or-v1-[A-Za-z0-9]{8,}/g, '[redacted]')
    .replace(/gsk_[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/r8_[A-Za-z0-9]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]');
}

export class OpenRouterError extends Error {
  constructor(kind, message, status = 502, detail) {
    super(message);
    this.name = 'OpenRouterError';
    this.kind = kind;
    this.status = status;
    this.detail = detail ? redactOpenRouter(detail) : undefined;
  }
}

export const OPENROUTER_ERRORS = {
  not_configured: 'OpenRouter is not configured on this deployment. No OpenRouter model is used.',
  key_rejected: 'OpenRouter rejected the configured key, so it is not being used. Replace OPENROUTER_API_KEY with a working key; the rejected key is not retried automatically.',
  unverified: 'An OpenRouter key is configured but has not been verified, so no request is sent to it.',
  unauthorized: 'OpenRouter refused this request. The server-side key may be invalid or revoked.',
  rate_limited: 'OpenRouter is rate-limiting requests right now. Please try again later.',
  timeout: 'OpenRouter did not respond in time. Please try again.',
  network: 'OpenRouter could not be reached.',
  upstream: 'OpenRouter returned an error.',
  bad_response: 'OpenRouter returned an empty response.',
  invalid_request: 'That request could not be sent to OpenRouter.',
};

/** True only when the cached verification says the key works. */
export function openrouterReady() {
  return openrouterConfigured() && openrouterCachedStatus().state === 'ok';
}

/**
 * Chat completion through OpenRouter.
 * Refuses locally — with no network call — when the key is missing, unverified or rejected.
 */
export async function openrouterChat({
  messages,
  model = OPENROUTER_MODEL,
  temperature = 0.6,
  maxTokens = 1200,
  timeoutMs = 30000,
  fetchImpl = globalThis.fetch,
  allowUnverified = false,
} = {}) {
  if (!openrouterConfigured()) {
    throw new OpenRouterError('not_configured', OPENROUTER_ERRORS.not_configured, 503);
  }

  const state = openrouterCachedStatus().state;
  if (state === 'invalid') {
    throw new OpenRouterError('key_rejected', OPENROUTER_ERRORS.key_rejected, 503);
  }
  if (state !== 'ok' && !allowUnverified) {
    // No silent attempt with a key we have not verified: that is how a rejected key gets
    // retried on every page load.
    throw new OpenRouterError('unverified', OPENROUTER_ERRORS.unverified, 503);
  }

  if (!Array.isArray(messages) || !messages.length) {
    throw new OpenRouterError('invalid_request', 'A messages array is required.', 400);
  }

  let response;
  try {
    response = await fetchImpl(CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Title': '#ash Mesh',
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new OpenRouterError(timedOut ? 'timeout' : 'network',
      timedOut ? OPENROUTER_ERRORS.timeout : OPENROUTER_ERRORS.network,
      timedOut ? 504 : 502, err?.message);
  }

  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }

  if (!response.ok) {
    const kind = response.status === 401 || response.status === 403 ? 'unauthorized'
      : response.status === 429 ? 'rate_limited' : 'upstream';
    throw new OpenRouterError(kind, OPENROUTER_ERRORS[kind] || OPENROUTER_ERRORS.upstream,
      response.status === 429 ? 429 : 502, data?.error?.message || raw.slice(0, 300));
  }

  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new OpenRouterError('bad_response', OPENROUTER_ERRORS.bad_response, 502);

  return { text, model: data?.model || model, usage: data?.usage || null, provider: 'openrouter' };
}

export function openrouterErrorBody(err) {
  const known = err instanceof OpenRouterError;
  return {
    error: `openrouter_${known ? err.kind : 'upstream'}`,
    message: known ? err.message : OPENROUTER_ERRORS.upstream,
    kind: known ? err.kind : 'upstream',
  };
}
