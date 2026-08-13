const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { createServer } = require('http');
const { Server } = require('socket.io');

const { env } = require('./config/env');
const logger = require('./utils/logger');
const attachSocketAuth = require('./sockets/auth');
const initSocketHandlers = require('./sockets/deviceEvents');

const app = express();
const httpServer = createServer(app);

// Behind the Google Cloud load balancer — trust the forwarded client address so
// rate limiting and audit logs key off the real caller, not the proxy.
app.set('trust proxy', env.trustProxy);
app.disable('x-powered-by');

// ── CORS ─────────────────────────────────────────────────────────────────────
/**
 * The allowlist is the whole of the policy.
 *
 * The web apps and the API are separate origins in every deployed environment:
 * Firebase Hosting serves parentix.ca, app.parentix.ca and admin.parentix.ca,
 * Cloud Run serves api.parentix.ca. Every browser call is therefore genuinely
 * cross-origin — there is no same-origin case left to fall back on — and a
 * hostname the API has not been told about must fail loudly at the browser
 * rather than work by accident. `env.corsOrigins` is built from CLIENT_URL,
 * ADMIN_URL and CORS_ORIGINS; Terraform sets all three.
 *
 * A request with no Origin at all is a non-browser caller — Stripe's webhook, an
 * uptime probe — which carries no ambient credentials for CORS to protect. Those
 * are allowed and authenticated the usual way.
 */
const isAllowedOrigin = (origin) =>
  !origin || env.corsOrigins.includes(origin.replace(/\/$/, ''));

const corsDelegate = (req, callback) => {
  const origin = req.headers?.origin;
  if (isAllowedOrigin(origin)) return callback(null, { origin: origin || true, credentials: true });
  callback(null, { origin: false });
};

/**
 * The handshake needs one thing REST must not have: an origin naming this host.
 *
 * The child app was assumed to be an origin-less caller and is not. React
 * Native's Android WebSocket sends one whether or not anyone asked:
 * WebSocketModule.java fills in `getDefaultOrigin(url)` when the caller supplies
 * no origin header, which for `wss://api.parentix.ca` is
 * `https://api.parentix.ca` — this API's own name, which no allowlist would
 * think to carry. engine.io refused with a bare `400 {"code":3}`, the client
 * retried at its 30s backoff ceiling, and across 14 days of production all 401
 * attempts from okhttp failed while every browser upgraded cleanly. Nothing
 * surfaced it: rules still arrived on the 60-second polling tick, so the app
 * looked alive while the realtime channel — heartbeats, blocked-app and
 * screen-time alerts, immediate unlink — was dead.
 *
 * Scoped to the socket deliberately. cors.test.js pins that REST refuses an
 * origin merely because it matches the request Host, which is the right call for
 * a browser-facing surface and is left exactly as it was. It is safe here for a
 * reason that does not hold there: this admits no one who was not already
 * admitted. A non-browser client can simply send no Origin and connect today, so
 * nothing is gained by spoofing a Host; and a browser cannot reach this branch
 * at all, because it sets Origin and Host itself and the two are equal only when
 * the page really was served from this API — which serves no HTML.
 */
const isSelfOrigin = (origin, host) =>
  !!host && origin.replace(/^https?:\/\//, '') === host;

/**
 * Socket.IO gets a `(req, callback)` delegate rather than the
 * `origin(origin, callback)` form, because that form is handed the origin alone
 * and the check above needs the Host to compare it against. The `cors` package
 * accepts a delegate in place of an options object, so the request stays
 * attached.
 *
 * It must *error* on a refusal rather than answer `{ origin: false }` the way
 * the Express delegate does, and the difference is not cosmetic. A REST refusal
 * only omits the CORS headers and leaves the browser to enforce it — correct
 * there, because the response never reaches the page. A handshake has no such
 * second line of defence: omit the headers and the upgrade still completes, and
 * a socket that has completed is connected whatever a browser makes of it.
 * Erroring is what makes engine.io abort. Both directions are pinned by
 * socketOrigin.test.js — the first draft of this fix answered `{ origin: false }`
 * and handed a third-party origin a working socket.
 */
const socketCorsDelegate = (req, callback) => {
  const origin = req.headers?.origin;
  if (isAllowedOrigin(origin) || isSelfOrigin(origin, req.headers?.host)) {
    return callback(null, { origin: origin || true, credentials: true });
  }
  callback(new Error(`Origin ${origin} is not allowed by CORS`));
};

const io = new Server(httpServer, { cors: socketCorsDelegate });
attachSocketAuth(io);

app.use(helmet());
app.use(cors(corsDelegate));
app.use(compression());

// ── Request context ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
});

// Stripe verifies the webhook signature against the exact bytes it sent, so this
// route must keep its raw body — registered before the JSON parser.
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '1mb' }));

// A broad backstop; individual routers add tighter limits where it matters.
app.use(
  '/api',
  rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    message: { error: 'Too many requests, please slow down' },
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ── Health probes ────────────────────────────────────────────────────────────
// `/health` answers as long as the process is up (this is the ALB target check);
// `/ready` additionally proves the database is reachable.
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.get('/api/ready', async (req, res) => {
  const { sequelize } = require('./config/db');
  try {
    await sequelize.authenticate();
    res.json({ status: 'ready' });
  } catch (err) {
    logger.error('Readiness check failed', { error: err.message });
    res.status(503).json({ status: 'unavailable' });
  }
});

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/auth/mfa', require('./routes/mfa'));
app.use('/api/children', require('./routes/children'));
app.use('/api/devices', require('./routes/devices'));
app.use('/api/screen-time', require('./routes/screenTime'));
app.use('/api/blocking', require('./routes/blocking'));
app.use('/api/activity', require('./routes/activity'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/alerts', require('./routes/alerts'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/locations', require('./routes/locations'));
app.use('/api/safe-zones', require('./routes/safeZones'));
app.use('/api/chats', require('./routes/chats'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/safety', require('./routes/safety'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/contact', require('./routes/contactForm'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/uploads', require('./routes/uploads'));
// Cloud Scheduler, not a browser — see routes/tasks.js.
app.use('/api/tasks', require('./routes/tasks'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ── Error handler ────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;

  if (status >= 500) {
    logger.error('Unhandled request error', {
      requestId: req.id,
      path: req.originalUrl,
      error: err.message,
      stack: err.stack,
    });
  }

  // Client errors carry a message worth showing; server errors never leak
  // internals (Sequelize text, stack frames) to the caller in production.
  const message = status < 500 || !env.isProduction ? err.message || 'Internal server error' : 'Internal server error';
  res.status(status).json({ error: message, requestId: req.id });
});

app.set('io', io);
initSocketHandlers(io);

module.exports = { app, httpServer, io };
