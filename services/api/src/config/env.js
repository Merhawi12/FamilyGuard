const NODE_ENV = process.env.NODE_ENV || 'development';

/**
 * A test run must not inherit the developer's `.env`.
 *
 * `tests/env.setup.js` pins the values the suite cares about *by setting them*,
 * because dotenv only fills keys that are missing — but that only covers the
 * keys somebody thought to list. Everything else leaked straight through, and
 * once real credentials landed in this file (Twilio going live is what did it)
 * three security tests started asserting against them: `config.test.js` checks
 * that a blank Twilio SID reads as "no provider" and got `twilio`, because the
 * developer's `SMS_PROVIDER` was sitting underneath it.
 *
 * That is worse than three red tests. A suite whose configuration comes partly
 * from an untracked file passes or fails differently on every machine, and the
 * checks most likely to be affected are exactly these — the ones that assert a
 * credential is *absent*. So the file is not read at all under NODE_ENV=test,
 * and the environment a test sees is the one `env.setup.js` states.
 */
if (NODE_ENV !== 'test') require('dotenv').config();

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

/**
 * Blanks out a value that is still the template's placeholder.
 *
 * `.env` files start life as a copy of `.env.example`, and a line left as
 * `sk_test_REPLACE_WITH_YOUR_STRIPE_SECRET_KEY` is indistinguishable from a real
 * key to any `if (value)` check — so code that means to degrade gracefully when
 * a service is unconfigured builds a client instead and fails on the first call
 * with whatever that service says. Treating a placeholder as absent restores the
 * distinction between "not set up" and "set up wrong".
 */
const configured = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  // `^your[-_]` is here because the shape a placeholder takes is whatever the
  // template happened to write, not a convention: production ran for over a week
  // with SMTP_USER literally `your-smtp-username`, which the underscore-and-
  // SECRET/KEY/ID form above does not match. Every verification and reset email
  // failed 535 at send time, one field away from a boot check that exists to
  // catch exactly this.
  return /REPLACE_WITH|YOUR_[A-Z_]*(KEY|SECRET|ID)|^your[-_]|^changeme$|^xxx+$/i.test(raw) ? '' : raw;
};

/**
 * A credential that has not been supplied yet, read as the empty string.
 *
 * `|| ''` is not enough, because the unsupplied value is not empty. Terraform
 * seeds every externally-supplied Secret Manager secret with a single space
 * (`secrets.tf`): a secret needs at least one version before Cloud Run can mount
 * it, and Secret Manager will not store a zero-length payload. That space is
 * truthy, so every `!!value` check reads a blank credential as a configured one.
 *
 * The consequence is not a loud failure, it is a quiet one. The mailer builds an
 * SMTP transport pointed at the host " ", every send throws and is swallowed by
 * the catch that stops a notification from failing its request — and the branch
 * that would have logged the reset code instead is skipped, because the service
 * believes it is configured. The caller is told the mail was sent. Nothing
 * arrives, and nothing says so.
 *
 * Trimming restores the distinction between "not set up" and "set up wrong".
 *
 * It runs `configured` for the same reason rather than trimming alone: a secret
 * that was created but never filled in carries the template's placeholder, and
 * a placeholder is no more a credential than a space is. Both are "not set up".
 */
const secret = (value) => configured(String(value ?? '').trim());

/** Normalises a VAPID contact to the `mailto:`/`https:` form push services require. */
const pushSubject = (value) => {
  const contact = String(value || '').trim();
  if (!contact) return '';
  return /^(mailto:|https?:\/\/)/i.test(contact) ? contact : `mailto:${contact}`;
};

/**
 * Deduplicated, because the same origin legitimately arrives more than once —
 * CLIENT_URL and ADMIN_URL are equal in any environment where one host serves
 * both apps.
 *
 * The Family App needs several entries of its own now that Firebase Hosting
 * serves it: the apex, `www`, `app.` and the `*.web.app` name the site keeps
 * for verification are four distinct browser origins for one deployment.
 * CORS_ORIGINS carries the extras.
 */
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
    /**
     * The server certificate to trust, PEM, supplied inline.
     *
     * Without one there is nothing to verify against — Cloud SQL presents a
     * per-instance certificate signed by a CA that is not in any base image — so
     * `rejectUnauthorized` had to default to false, which is TLS that encrypts
     * and authenticates nothing: anything that can answer on that address gets
     * the database password and every query. Over private IP that is a small
     * exposure, and it is not nothing.
     *
     * Supplying the CA is what makes verification possible, so verification
     * *defaults on whenever it is supplied* and the operator does not have to
     * remember a second switch. Download it with
     * `gcloud sql instances describe <instance> --format='value(serverCaCert.cert)'`
     * and put it in Secret Manager as DB_SSL_CA.
     *
     * The old default is unchanged when no CA is configured, because flipping it
     * would take every existing deployment offline at boot rather than warning
     * them — `server.js` logs the weakened state instead, so it is visible.
     */
    sslCa: (process.env.DB_SSL_CA || '').trim(),
    sslRejectUnauthorized: bool(process.env.DB_SSL_REJECT_UNAUTHORIZED, !!(process.env.DB_SSL_CA || '').trim()),
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

  /**
   * Sign in with Google.
   *
   * Deliberately separate from `gcp` below: that is the project the API runs in,
   * this is an OAuth client someone created in a console. They are unrelated,
   * and conflating them is how a deployment ends up trusting the wrong audience.
   *
   * Every value here is a *public* client ID, not a secret — the browser sends
   * it to Google in the clear. What makes the flow safe is that the ID token
   * coming back is signed by Google and its `aud` claim is checked against this
   * list. An empty list disables the feature rather than accepting any audience,
   * which would let a token minted for someone else's app sign in here.
   *
   * Several IDs because one product needs several clients: a Web client for the
   * browser, and an Android client for the packaged app, each minting tokens
   * with its own `aud`.
   */
  googleSignIn: {
    audiences: [
      ...new Set([
        ...list(configured(process.env.GOOGLE_CLIENT_ID)),
        ...list(process.env.GOOGLE_EXTRA_CLIENT_IDS),
      ]),
    ],
  },

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
    from: process.env.EMAIL_FROM || process.env.SMTP_FROM || 'Parentix <support@parentix.ca>',
    adminAddress: process.env.ADMIN_EMAIL || '',
    smtp: {
      // Trimmed, not just defaulted: an unsupplied Secret Manager version is a
      // single space, and a blank host that reads as configured is what turns
      // "password reset does not work" into a silent failure. See `secret`.
      host: secret(process.env.SMTP_HOST),
      port: int(process.env.SMTP_PORT, 587),
      secure: bool(process.env.SMTP_SECURE, false),
      user: secret(process.env.SMTP_USER),
      pass: secret(process.env.SMTP_PASS),
    },
  },

  /**
   * Outbound SMS, for phone sign-in codes.
   *
   * Twilio's REST shape rather than a vendor SDK, because it is the one most
   * providers imitate: MessageBird, Vonage's compatibility endpoint, Plivo and
   * several regional gateways all accept the same form-encoded POST, so pointing
   * `baseUrl` elsewhere is usually the whole of switching provider.
   *
   * `secret()` for the credentials for the same reason SMTP uses it — an
   * unsupplied Secret Manager version arrives as a single space, and a blank
   * token that reads as configured is how "nobody can sign in by phone" becomes
   * a silent failure instead of a loud one.
   */
  sms: {
    // `secret()` on the SID too: Terraform seeds this secret with a single
    // space like every other supplied one, and a space here is truthy — which
    // would select the 'twilio' provider on a deployment that has not been
    // given credentials yet, so `isEnabled()` would be deciding against a
    // provider name derived from a blank.
    provider: (process.env.SMS_PROVIDER || (secret(process.env.TWILIO_ACCOUNT_SID) ? 'twilio' : 'none')).toLowerCase(),
    baseUrl: process.env.SMS_API_BASE_URL || 'https://api.twilio.com',
    accountSid: secret(process.env.TWILIO_ACCOUNT_SID),
    authToken: secret(process.env.TWILIO_AUTH_TOKEN),
    // The sending number, or a Messaging Service SID — Twilio accepts either in
    // place of `From`, and a messaging service is what gives you a sender pool.
    from: secret(process.env.TWILIO_FROM_NUMBER),
    messagingServiceSid: secret(process.env.TWILIO_MESSAGING_SERVICE_SID),

    /**
     * Return the verification code in the HTTP response, so phone sign-in can be
     * walked end to end without an SMS provider.
     *
     * This exists because the alternative was that nobody could exercise the
     * flow at all: with no credentials `isEnabled()` is false, the sign-in page
     * asks `/auth/providers` and hides the Phone tab entirely, and the only copy
     * of the code is a line in the API log. A feature that cannot be run in
     * development is a feature that gets shipped untested.
     *
     * Two things keep it from becoming a way in:
     *
     *   - it is off in production and cannot be turned on — `isDevelopment` is
     *     false there, and `assertProductionConfig` refuses to boot at all if
     *     SMS_ECHO_CODE is set, rather than quietly ignoring it;
     *   - it is off the moment a real provider is configured, because then the
     *     code goes where it is supposed to go.
     *
     * NODE_ENV is load-bearing for this, as it already is for `auth.jwtSecret` —
     * an environment that leaves it unset is one where sessions can be forged
     * with a published constant, so this is not the weak link.
     */
    echoCode: bool(process.env.SMS_ECHO_CODE, !isProduction && !isTest),

    /**
     * Whether SMS_ECHO_CODE was set at all, as opposed to what it resolved to.
     *
     * `echoCode` above is false in production no matter what was asked for, so
     * by the time anything reads it the operator's intent has already been
     * discarded — and intent is exactly what the production boot check needs to
     * see. Captured here rather than read from `process.env` inside the check
     * because configuration in this module is resolved once, at require time.
     */
    echoCodeRequested: bool(process.env.SMS_ECHO_CODE, false),
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

  push: {
    /**
     * Web Push to a parent's browser. Without a VAPID keypair the browser has
     * nothing to subscribe against, so the feature reports itself unavailable
     * rather than half-working — generate one with
     * `node scripts/generate-vapid-keys.js`.
     */
    // Same placeholder trap as SMTP: a single space here makes
    // GET /api/notifications/push/config report push as available, and every
    // browser subscription then fails against a key that is one space long.
    vapidPublicKey: secret(process.env.VAPID_PUBLIC_KEY),
    vapidPrivateKey: secret(process.env.VAPID_PRIVATE_KEY),
    // Push services require a contact for the sender: a mailto: or https URL.
    // A bare address is accepted and turned into one.
    vapidSubject: pushSubject(process.env.VAPID_SUBJECT || process.env.ADMIN_EMAIL),

    /**
     * Firebase Cloud Messaging, for the parent's Android app.
     *
     * The Android wrapper is a WebView and WebView has no Push API, so the
     * VAPID transport above cannot reach it — FCM is the only route to that
     * app. Sends are authenticated with Application Default Credentials, which
     * on Cloud Run means the service account and no stored key at all; the
     * project id is the only configuration.
     *
     * FCM_PROJECT_ID exists for the case where messaging lives in a different
     * Firebase project from the one hosting the API. Normally they are the same
     * and GCP_PROJECT_ID is enough.
     */
    fcmProjectId: secret(process.env.FCM_PROJECT_ID || process.env.GCP_PROJECT_ID),

    /**
     * Expo push to the child device. Expo's endpoint accepts unauthenticated
     * sends; the token is only required once the project enables enhanced
     * security, so it stays optional.
     */
    expoEndpoint: process.env.EXPO_PUSH_ENDPOINT || 'https://exp.host/--/api/v2/push/send',
    expoAccessToken: process.env.EXPO_ACCESS_TOKEN || '',
    // Lets tests and local runs record sends without reaching a push service.
    enabled: bool(process.env.PUSH_ENABLED, !isTest),
  },

  /**
   * Recurring work — the hourly safety-analysis pass.
   *
   * Two runners, because the same code has to work in two places that schedule
   * very differently:
   *
   *   internal   A setInterval inside the process. Right for local development,
   *              Docker Compose and the single-host deployment, where there is
   *              one long-lived process and nothing else to drive it.
   *   external   Cloud Scheduler POSTs to /api/tasks/safety-analysis and the
   *              in-process timer does not run at all.
   *
   * On Cloud Run `internal` is wrong in both directions at once. A service
   * scaled to zero has its CPU throttled between requests, so the timer simply
   * never fires; a service scaled to six runs six copies of the same hourly
   * pass. Neither is visible from the outside — the job is idempotent, so the
   * duplicate case looks fine and the never-fires case looks like a feature that
   * was never used.
   */
  jobs: {
    runner: (process.env.JOB_RUNNER || 'internal').toLowerCase(),
    /**
     * The service account Cloud Scheduler signs its OIDC token with. The task
     * endpoint accepts nothing else.
     *
     * Cloud Run cannot gate these calls itself: the service is invokable by
     * allUsers because Stripe's webhook and the child app both have to reach it
     * without a Google identity, so IAM lets the scheduler's request through
     * along with everyone else's and the audience check has to happen here.
     * Empty means no caller can qualify, and the endpoint answers 503 rather
     * than running unauthenticated.
     */
    schedulerServiceAccount: secret(process.env.SCHEDULER_SERVICE_ACCOUNT),
    /**
     * The `aud` claim to require. Cloud Scheduler sets it to whatever the job
     * config names, which is the service's own base URL — pinning it stops a
     * token minted for some other service from being replayed against this one.
     * Falls back to the request URL when unset.
     */
    tasksAudience: (process.env.TASKS_AUDIENCE || '').replace(/\/$/, ''),
  },

  stripe: {
    secretKey: configured(process.env.STRIPE_SECRET_KEY),
    webhookSecret: configured(process.env.STRIPE_WEBHOOK_SECRET),
    premiumPriceId: configured(process.env.STRIPE_PREMIUM_PRICE_ID),
    // Family Plus is no longer sold. Customers who bought it keep their $14.99
    // subscription, so the webhook still has to recognise this price and map it
    // to Premium. Safe to unset once no live subscription uses it.
    legacyFamilyPriceId: configured(process.env.STRIPE_FAMILY_PRICE_ID),
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

  /**
   * Mail is not optional in production, because signup does not complete without it.
   *
   * An account cannot log in until the emailed code is entered, and the code
   * exists only in that email — so a production boot with no relay configured
   * accepts registrations all day and strands every one of them, while
   * `/api/health` reports a perfectly healthy service. Password reset fails the
   * same way, for the people least able to work around it.
   *
   * This has already happened here once: a Secret Manager placeholder left
   * SMTP_HOST as a single space and every email on the platform stopped, with
   * nothing to say so. `secret()` now trims that back to empty, which is what
   * makes this check able to see it.
   */
  if (!env.email.smtp.host) missing.push('SMTP_HOST (production cannot deliver verification or reset email without it)');

  /**
   * And the credentials, for the same reason — checking only the host is what
   * let this happen a second time.
   *
   * A host on its own passes every check in this file and then fails at the
   * relay with `535 Authentication failed`, once per email, forever. That is
   * indistinguishable from working: `/api/health` is green, registration
   * answers 201, and the parent waits for a code that was refused at the door.
   * The first check caught an empty host; this one catches an empty login,
   * which is the same outage with a different error string.
   *
   * A relay that authenticates by IP rather than by password does exist — an
   * internal Postfix, a Workspace restricted relay — and would be failed
   * wrongly here. That is the trade taken deliberately: this platform sends
   * through Brevo, and a deployment that genuinely needs anonymous relay can
   * say so by setting EMAIL_PROVIDER to something other than 'smtp'.
   */
  if (env.email.provider === 'smtp') {
    if (!env.email.smtp.user) missing.push('SMTP_USER (the relay refuses every message without it)');
    if (!env.email.smtp.pass) missing.push('SMTP_PASS (the relay refuses every message without it)');
  }

  if (missing.length) {
    throw new Error(`Refusing to start: missing or invalid configuration → ${missing.join(', ')}`);
  }

  /**
   * Refused rather than ignored.
   *
   * `sms.echoCode` already reads false in production regardless of this value,
   * so silently continuing would be safe — and that is exactly the problem. An
   * operator who set SMS_ECHO_CODE in a production environment believes sign-in
   * codes are being returned in the response, and would be right about the
   * intent and wrong about the effect. Failing the boot is how they find out
   * they meant to deploy something else.
   */
  if (env.sms.echoCodeRequested) {
    throw new Error(
      'Refusing to start: SMS_ECHO_CODE returns sign-in codes in the HTTP response and must never be set in production'
    );
  }
};

module.exports = { env, assertProductionConfig };
