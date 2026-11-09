// #ash Mesh — server-side Groq provider client.
//
// SECURITY CONTRACT (enforced here, not by convention):
//   * The API key is read from process.env.GROQ_API_KEY only, inside this module.
//   * The key is never returned in a response body, never written to a log line and
//     never embedded in an error message that reaches a client.
//   * Any provider text is passed through redact() before it can be surfaced, so an
//     upstream message that echoes a key cannot leak it.
//
// If GROQ_API_KEY is absent we throw GroqError('not_configured') — we never fabricate
// an answer. A missing key is an honest 503, not a simulated completion.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Groq retires model ids over time (llama-3.3-70b-versatile is no longer served). An
// explicit GROQ_MODEL always wins and is never silently substituted; otherwise we start
// from a current model and may fall back to another live model if the default is retired.
const EXPLICIT_MODEL = process.env.GROQ_MODEL || '';
export const GROQ_MODEL = EXPLICIT_MODEL || 'openai/gpt-oss-20b';
const FALLBACK_MODELS = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'];

/** Model ids to try, in order. */
function modelCandidates() {
  return EXPLICIT_MODEL ? [EXPLICIT_MODEL] : [GROQ_MODEL, ...FALLBACK_MODELS];
}

/** True when a provider error means "this model id is gone", not a real request failure. */
function isRetiredModel(err) {
  const text = String(err?.detail || err?.message || '');
  return (
    /model/i.test(text) &&
    /(not found|does not exist|decommission|retired|no longer supported|invalid model|model_not_found)/i.test(text)
  );
}

/** True when this deployment can actually reach Groq. */
export function groqConfigured() {
  return !!process.env.GROQ_API_KEY;
}

/** User-facing, human wording per failure kind. No provider internals, no key. */
export const FRIENDLY_ERRORS = {
  not_configured:
    '#ash AI is not connected on this deployment yet. The Founder must add the GROQ_API_KEY environment variable. No simulated AI answers are produced.',
  unauthorized:
    '#ash AI could not authenticate with the AI provider. The server-side key looks invalid or has been revoked.',
  rate_limited: '#ash AI is handling too many requests right now. Please try again in a moment.',
  timeout: '#ash AI took too long to answer. Please try again.',
  network: '#ash AI could not reach the AI provider. Check the connection and try again.',
  upstream: 'The AI provider returned an error. Please try again.',
  bad_response: 'The AI provider returned an empty response. Please try again.',
  invalid_request: 'That request could not be sent to #ash AI.',
};

/** Remove anything that looks like a credential from arbitrary text. */
export function redact(value) {
  let text = String(value == null ? '' : value);
  const key = process.env.GROQ_API_KEY;
  if (key && key.length >= 8) text = text.split(key).join('[redacted]');
  return text
    .replace(/gsk_[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]');
}

export class GroqError extends Error {
  constructor(kind, detail, status = 502) {
    super(FRIENDLY_ERRORS[kind] || FRIENDLY_ERRORS.upstream);
    this.name = 'GroqError';
    this.kind = kind;
    this.status = status;
    // Safe for server-side diagnostics only — never sent to a client.
    this.detail = detail ? redact(detail) : undefined;
  }
}

/**
 * Call Groq's OpenAI-compatible chat completions endpoint.
 * Returns { text, model, usage, provider } on success; throws GroqError otherwise.
 */
export async function groqChat({
  messages,
  temperature = 0.6,
  maxTokens = 900,
  json = false,
  timeoutMs = 30000,
} = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new GroqError('not_configured', 'GROQ_API_KEY is not set', 503);
  if (!Array.isArray(messages) || !messages.length) {
    throw new GroqError('invalid_request', 'messages array is required', 400);
  }

  const payload = { model: GROQ_MODEL, messages, temperature, max_tokens: maxTokens };
  if (json) payload.response_format = { type: 'json_object' };

  let response;
  try {
    response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const kind = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network';
    throw new GroqError(kind, err?.message, kind === 'timeout' ? 504 : 502);
  }

  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const kind =
      response.status === 401 || response.status === 403
        ? 'unauthorized'
        : response.status === 429
          ? 'rate_limited'
          : response.status === 400
            ? 'invalid_request'
            : 'upstream';
    throw new GroqError(
      kind,
      data?.error?.message || `HTTP ${response.status}`,
      response.status === 429 ? 429 : 502
    );
  }

  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new GroqError('bad_response', 'completion contained no text', 502);

  return {
    text,
    model: data?.model || GROQ_MODEL,
    usage: data?.usage || null,
    provider: 'groq',
  };
}

/** Response body for a failed AI call. Contains no key, no provider stack trace. */
export function groqErrorBody(err) {
  const known = err instanceof GroqError;
  const kind = known ? err.kind : 'upstream';
  return {
    error: `ai_${kind}`,
    message: known ? err.message : FRIENDLY_ERRORS.upstream,
    kind,
  };
}
