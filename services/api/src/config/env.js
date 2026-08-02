require('dotenv').config();

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const list = (value) =>
  String(value || '')
    .split(',')
    .map((entry) => entry.trim().replace(/\/$/, ''))
    .filter(Boolean);

/**
 * Every browser origin allowed to call the API. The Family App and Admin
 * Dashboard are separate deployments, so both must be listed; CORS_ORIGINS can
 * add more (staging previews, custom domains) without a code change.
 *
 * The localhost defaults are for `npm run dev` only and are withheld in
 * production for two reasons: a deployed service should never accept
 * credentialed requests from a page on somebody's laptop, and — less obviously —
 * a default here would make the CLIENT_URL check in assertProductionConfig
 * unreachable, since the list could never come out empty. A production boot
 * that forgot CLIENT_URL would then quietly serve with localhost origins
 * instead of failing, which is the exact outcome that check exists to prevent.
 */
const devOrigin = (fallback) => (isProduction ? '' : fallback);

// Deduplicated: without a custom domain both apps are served from the same
// bucket host, so the same origin arrives twice.
const corsOrigins = [
  ...new Set([
    ...list(process.env.CLIENT_URL || devOrigin('http://localhost:3000')),
    ...list(process.env.ADMIN_URL || devOrigin('http://localhost:3001')),
    ...list(process.env.CORS_ORIGINS),
  ]),
];

/**
 * Postgres can be configured three ways:
 *
 *   DB_SOCKET_PATH        Cloud SQL Unix socket, e.g.
 *                         /cloudsql/<project>:<region>:<instance>. This is how
 *                         Cloud Run reaches Cloud SQL when the instance is
 *                         attached to the service — the connection never leaves
 *                         the sandbox, so it needs no VPC connector and no TLS
 *                         configuration of its own.
 *   DB_HOST/DB_USER/…     discrete fields — Cloud SQL over private IP through
 *                         the Serverless VPC Access connector, and what a Secret
 *                         Manager secret injects most naturally.
 *   DATABASE_URL          a single connection string (local, Docker Compose).
 *
 * More specific wins, so a deployment never has to compose the URL itself.
 */
const dbSocketPath = process.env.DB_SOCKET_PATH || '';

const buildDatabaseUrl = () => {
  const { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD } = process.env;
  if (!DB_HOST || !DB_USER) return process.env.DATABASE_URL || '';

  const credentials = `${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD || '')}`;
  return `postgresql://${credentials}@${DB_HOST}:${DB_PORT || 5432}/${DB_NAME || 'parentix'}`;
};

const databaseUrl = buildDatabaseUrl();
const usePostgres = !!dbSocketPath || /^postgres(ql)?:\/\//.test(databaseUrl);

const env = Object.freeze({
  NODE_ENV,
  isProduction,
  isTest,
  isDevelopment: !isProduction && !isTest,

  port: int(process.env.PORT, 5000),
  logLevel: process.env.LOG_LEVEL || (isTest ? 'silent' : 'info'),

  // Behind the external HTTPS load balancer there is exactly one proxy hop in
  // front of Express.
  trustProxy: int(process.env.TRUST_PROXY, 1),

  db: {
    url: databaseUrl,
    usePostgres,
    /** Cloud SQL Unix socket. When set, host/port are not used at all. */
    socketPath: dbSocketPath,
    name: process.env.DB_NAME || 'parentix',
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    // A Unix socket connection to Cloud SQL is already confined to the instance
    // sandbox, so TLS on top of it buys nothing and only adds a handshake.
    // Over private IP, Cloud SQL presents a Google-issued certificate whose CA
    // is not in the image, so strict verification stays opt-in.
    ssl: bool(process.env.DB_SSL, usePostgres && isProduction && !dbSocketPath),
    sslRejectUnauthorized: bool(process.env.DB_SSL_REJECT_UNAUTHORIZED, false),
    sqlitePath: process.env.DB_PATH || './parentix.sqlite',
    poolMax: int(process.env.DB_POOL_MAX, 10),
    logging: bool(process.env.DB_LOGGING, false),
  },

  auth: {
    jwtSecret: process.env.JWT_SECRET || (isProduction ? '' : 'dev_only_insecure_secret'),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
    fieldEncryptionKey: process.env.FIELD_ENCRYPTION_KEY || '',
    // Minimum password length accepted at registration and password change.
    minPasswordLength: int(process.env.MIN_PASSWORD_LENGTH, 10),
  },

  corsOrigins,
  clientUrl: corsOrigins[0] || 'http://localhost:3000',
  adminUrl: list(process.env.ADMIN_URL)[0] || 'http://localhost:3001',

  // Empty disables the Redis-backed Socket.IO adapter, which is only needed
  // when more than one API task is running.
  redisUrl: process.env.REDIS_URL || '',

  gcp: {
    // Usually inferred from the metadata server on Cloud Run; set explicitly for
    // local runs and for anything that signs URLs.
    projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID || '',
    location: process.env.GCP_REGION || 'us-central1',
  },

  email: {
    // 'smtp' for any relay (SendGrid, Mailgun, Postmark, Workspace), 'none'
    // logs instead of sending. Google Cloud has no first-party email service.
    provider: (process.env.EMAIL_PROVIDER || (process.env.SMTP_HOST ? 'smtp' : 'none')).toLowerCase(),
    from: process.env.EMAIL_FROM || process.env.SMTP_FROM || 'Parentix <no-reply@parentix.ca>',
    adminAddress: process.env.ADMIN_EMAIL || '',
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: int(process.env.SMTP_PORT, 587),
      secure: bool(process.env.SMTP_SECURE, false),
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
  },

  storage: {
    // 'gcs' for Cloud Storage, 'none' rejects upload requests with 503.
    provider: (process.env.STORAGE_PROVIDER || (process.env.GCS_BUCKET ? 'gcs' : 'none')).toLowerCase(),
    bucket: process.env.GCS_BUCKET || '',
    // Cloud CDN domain in front of the bucket; falls back to the direct GCS URL.
    publicBaseUrl: (process.env.GCS_PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    uploadUrlTtlSeconds: int(process.env.GCS_UPLOAD_URL_TTL, 300),
    maxUploadBytes: int(process.env.MAX_UPLOAD_BYTES, 5 * 1024 * 1024),
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    premiumPriceId: process.env.STRIPE_PREMIUM_PRICE_ID || '',
    familyPriceId: process.env.STRIPE_FAMILY_PRICE_ID || '',
  },
});

/**
 * Fails fast on a misconfigured production boot rather than serving traffic with
 * an insecure default. Called from the server entrypoint, not at import time, so
 * tests and tooling can require this module freely.
 */
const assertProductionConfig = () => {
  if (!env.isProduction) return;

  const missing = [];
  if (!env.auth.jwtSecret || env.auth.jwtSecret.length < 32) missing.push('JWT_SECRET (min 32 chars)');
  if (!/^[0-9a-f]{64}$/i.test(env.auth.fieldEncryptionKey)) missing.push('FIELD_ENCRYPTION_KEY (64 hex chars)');
  if (!env.db.usePostgres) missing.push('DB_SOCKET_PATH, DB_HOST, or DATABASE_URL (Postgres connection)');
  if (env.db.socketPath && !env.db.user) missing.push('DB_USER (required with DB_SOCKET_PATH)');
  if (!env.corsOrigins.length) missing.push('CLIENT_URL');

  if (missing.length) {
    throw new Error(`Refusing to start: missing or invalid configuration → ${missing.join(', ')}`);
  }
};

module.exports = { env, assertProductionConfig };
