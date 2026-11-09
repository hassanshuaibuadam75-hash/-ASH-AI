// #ash Mesh — integrated #ash AI assistant (server-side proxy; API secret never reaches the client).
// The assistant only ever receives text the user explicitly submits. It has no access to
// end-to-end encrypted messages, which the server cannot decrypt.
import express from 'express';
import { db, uid, now } from '../db.js';
import { requireAuth, rateLimit, clean, badRequest } from '../lib.js';

const router = express.Router();

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const FEATURES = {
  compose: {
    label: 'Writing assistance',
    system:
      'You are #ash AI, a writing assistant inside the #ash Mesh social network. Improve the user\'s draft post. Keep their meaning and voice, be concise, and return only the improved text without commentary.',
  },
  reply: {
    label: 'Reply suggestions',
    system:
      'You are #ash AI inside #ash Mesh. Suggest three short, friendly reply options for the message the user provides. Number them 1-3, one line each, no extra commentary.',
  },
  translate: {
    label: 'Translation',
    system:
      'You are #ash AI, a translation assistant. Translate the user\'s text into the requested target language. Preserve names and tone. Return only the translation.',
  },
  caption: {
    label: 'AI captions',
    system:
      'You are #ash AI inside #ash Mesh. Write one engaging caption (max 180 characters) for the media the user describes, optionally with hashtags. Return only the caption.',
  },
  summarize: {
    label: 'Content understanding',
    system:
      'You are #ash AI. Summarise the user-provided content in at most five bullet points, in the requested language. Only use the supplied text.',
  },
  discover: {
    label: 'Information discovery',
    system:
      'You are #ash AI, a helpful research assistant inside #ash Mesh. Answer the user\'s question clearly and briefly. If you are unsure, say so instead of inventing facts.',
  },
  language: {
    label: 'Language assistance',
    system:
      'You are #ash AI, a multilingual language helper. Explain or correct the user\'s text and give a natural rewrite. Be brief.',
  },
};

router.get('/ai/status', requireAuth, (req, res) => {
  res.json({
    configured: !!process.env.GROQ_API_KEY,
    provider: 'groq',
    model: DEFAULT_MODEL,
    features: Object.entries(FEATURES).map(([key, v]) => ({ key, label: v.label })),
    privacy:
      'Requests contain only the text you submit. #ash AI cannot read your end-to-end encrypted messages.',
  });
});

router.post(
  '/ai/assist',
  requireAuth,
  rateLimit({ name: 'ai', limit: 40, windowMs: 60 * 60 * 1000 }),
  async (req, res) => {
    const feature = clean(req.body.feature, 30);
    const text = clean(req.body.text, 4000);
    const targetLanguage = clean(req.body.targetLanguage, 40);
    const tone = clean(req.body.tone, 30);
    const spec = FEATURES[feature];
    if (!spec) return badRequest(res, 'Unknown AI feature.');
    if (!text) return badRequest(res, 'Provide the text you want help with.');

    const daily = db.prepare('SELECT COUNT(*) AS n FROM ai_usage WHERE user_id = ? AND created_at >= ?')
      .get(req.user.id, new Date(Date.now() - 86400000).toISOString()).n;
    if (daily >= 200) {
      return res.status(429).json({ error: 'ai_daily_limit', message: 'Daily #ash AI limit reached. Try again tomorrow.' });
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        error: 'ai_not_configured',
        message:
          '#ash AI is not connected on this deployment yet. The Founder must add the GROQ_API_KEY environment variable; no simulated AI responses are produced.',
      });
    }

    let userPrompt = text;
    if (feature === 'translate') userPrompt = `Target language: ${targetLanguage || 'English'}\n\n${text}`;
    if (feature === 'compose' && tone) userPrompt = `Tone: ${tone}\n\n${text}`;
    if (feature === 'summarize' && targetLanguage) userPrompt = `Respond in: ${targetLanguage}\n\n${text}`;

    try {
      const response = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          messages: [
            { role: 'system', content: spec.system },
            { role: 'user', content: userPrompt },
          ],
          temperature: feature === 'translate' ? 0.2 : 0.6,
          max_tokens: 900,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await response.json();
      const output = data?.choices?.[0]?.message?.content?.trim();
      const ok = response.ok && !!output;
      db.prepare('INSERT INTO ai_usage (id, user_id, feature, ok, created_at) VALUES (?,?,?,?,?)')
        .run(uid('aiu_'), req.user.id, feature, ok ? 1 : 0, now());
      if (!ok) {
        return res.status(502).json({
          error: 'ai_upstream_error',
          message: data?.error?.message || 'The AI provider did not return a usable response.',
        });
      }
      res.json({ text: output, model: DEFAULT_MODEL, feature });
    } catch (err) {
      db.prepare('INSERT INTO ai_usage (id, user_id, feature, ok, created_at) VALUES (?,?,?,?,?)')
        .run(uid('aiu_'), req.user.id, feature, 0, now());
      res.status(502).json({ error: 'ai_unreachable', message: `Could not reach the AI provider: ${err.message}` });
    }
  }
);

export default router;
