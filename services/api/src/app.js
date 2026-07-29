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

// Behind the ALB (and CloudFront) — trust the forwarded client address so rate
// limiting and audit logs key off the real caller, not the proxy.
app.set('trust proxy', env.trustProxy);
app.disable('x-powered-by');

// ── CORS ─────────────────────────────────────────────────────────────────────
// Same-origin deployments (CloudFront routing /api/* to the ALB) send no Origin
// header at all; cross-origin callers must be on the allowlist.
const corsOptions = {
  origin(origin, callback) {
    if (!origin || env.corsOrigins.includes(origin.replace(/\/$/, ''))) return callback(null, true);
    callback(new Error(`Origin ${origin} is not allowed by CORS`));
  },
  credentials: true,
};

const io = new Server(httpServer, { cors: corsOptions });
attachSocketAuth(io);

app.use(helmet());
app.use(cors(corsOptions));
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
