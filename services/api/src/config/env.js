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
 */
const corsOrigins = [
  ...list(process.env.CLIENT_URL || 'http://localhost:3000'),
  ...list(process.env.ADMIN_URL || 'http://localhost:3001'),
  ...list(process.env.CORS_ORIGINS),
];

const databaseUrl = process.env.DATABASE_URL || '';
const usePostgres = /^postgres(ql)?:\/\//.test(databaseUrl);

const env = Object.freeze({
  NODE_ENV,
  isProduction,
  isTest,
  isDevelopment: !isProduction && !isTest,

  port: int(process.env.PORT, 5000),
  logLevel: process.env.LOG_LEVEL || (isTest ? 'silent' : 'info'),

  // Behind the ALB/CloudFront there is exactly one proxy hop in front of Express.
  trustProxy: int(process.env.TRUST_PROXY, 1),

  db: {
    url: databaseUrl,
    usePostgres,
    // RDS presents an AWS-issued certificate; verification needs the RDS CA
    // bundle in the image, so it is opt-in via DB_SSL_REJECT_UNAUTHORIZED.
    ssl: bool(process.env.DB_SSL, usePostgres && isProduction),
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

  aws: {
    region: process.env.AWS_REGION || 'us-east-2',
  },

  email: {
    // 'ses' in AWS, 'smtp' for a self-hosted relay, 'none' logs instead of sending.
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
    // 's3' in AWS, 'none' rejects upload requests with 503.
    provider: (process.env.STORAGE_PROVIDER || (process.env.S3_BUCKET ? 's3' : 'none')).toLowerCase(),
    bucket: process.env.S3_BUCKET || '',
    // CloudFront domain in front of the bucket; falls back to the S3 URL.
    publicBaseUrl: (process.env.S3_PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    uploadUrlTtlSeconds: int(process.env.S3_UPLOAD_URL_TTL, 300),
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
  if (!env.db.usePostgres) missing.push('DATABASE_URL (postgres:// connection string)');
  if (!env.corsOrigins.length) missing.push('CLIENT_URL');

  if (missing.length) {
    throw new Error(`Refusing to start: missing or invalid configuration → ${missing.join(', ')}`);
  }
};

module.exports = { env, assertProductionConfig };
