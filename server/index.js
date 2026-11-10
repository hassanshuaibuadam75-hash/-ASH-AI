// #ash Mesh — application server.
// Serves the real API and the built client. Uploaded files are never served statically:
// every file goes through /api/media/:id, which enforces access rules.
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureFounder } from './db.js';
import { loadSession, csrfProtection } from './lib.js';
import authRoutes from './routes-auth.js';
import socialRoutes from './routes-social.js';
import chatRoutes from './routes-chat.js';
import marketRoutes from './routes-market.js';
import adminRoutes from './routes-admin.js';
import aiRoutes from './routes-ai.js';
import aiOfficialRoutes from './routes-ai-official.js';
import moderationRoutes from './routes-moderation.js';
import syncRoutes from './routes-sync.js';
import contentRoutes from './routes-content.js';
import heritageRoutes from './routes-heritage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=(self), bluetooth=(self)');
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );
  if (req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Keep the raw body for provider webhook signature verification.
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      if (buf?.length) req.rawBody = buf.toString('utf8');
    },
  })
);
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser());
app.use(loadSession);
app.use(csrfProtection);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: '#ash Mesh', time: new Date().toISOString(), uptimeSeconds: Math.round(process.uptime()) });
});

app.use('/api', authRoutes);
app.use('/api', socialRoutes);
app.use('/api', chatRoutes);
app.use('/api', marketRoutes);
app.use('/api', adminRoutes);
app.use('/api', aiRoutes);
app.use('/api', aiOfficialRoutes);
app.use('/api', moderationRoutes);
app.use('/api', syncRoutes);
app.use('/api', contentRoutes);
app.use('/api', heritageRoutes);

app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found', message: 'API endpoint not found.' }));

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h', etag: true }));
  app.get('*', (req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
} else {
  app.get('/', (_req, res) =>
    res.status(503).type('html').send('<h1>#ash Mesh</h1><p>The client build is missing. Run <code>npm run build</code>.</p>')
  );
}

app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[#ash Mesh] request error:', err);
  res.status(status).json({
    error: status === 413 ? 'payload_too_large' : 'server_error',
    message: status >= 500 ? 'Something went wrong on our side. Please try again.' : err.message,
  });
});

ensureFounder();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[#ash Mesh] listening on 0.0.0.0:${PORT}`);
  if (!process.env.GROQ_API_KEY) console.log('[#ash Mesh] #ash AI: GROQ_API_KEY not set — assistant reports as not configured.');
  if (!process.env.PAYSTACK_SECRET_KEY) console.log('[#ash Mesh] Payments: PAYSTACK_SECRET_KEY not set — orders recorded as pending payment.');
  if (!process.env.RESEND_API_KEY) console.log('[#ash Mesh] Email: RESEND_API_KEY not set — password reset links are not emailed.');
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
