/**
 * Configuration is resolved once, at require time, from process.env. These
 * tests therefore reload the module under a controlled environment rather than
 * importing it at the top of the file like every other suite.
 *
 * What they protect is the production boot contract: a deployed API must never
 * fall back to a development default, and it must refuse to start rather than
 * serve traffic with one.
 */

// dotenv fills only missing keys, but tests/env.setup.js has already populated
// the interesting ones, and a developer's services/api/.env would otherwise
// change the outcome of these assertions. Neutralising it keeps the suite
// hermetic on any machine.
jest.mock('dotenv', () => ({ config: () => ({ parsed: {} }) }));

const CONFIG_KEYS = [
  'NODE_ENV',
  'CLIENT_URL',
  'ADMIN_URL',
  'CORS_ORIGINS',
  'DB_SOCKET_PATH',
  'DB_USER',
  'DATABASE_URL',
  'JWT_SECRET',
  'FIELD_ENCRYPTION_KEY',
  'SMS_ECHO_CODE',
  'TWILIO_ACCOUNT_SID',
];

/** Loads src/config/env.js fresh under exactly the variables given. */
const loadConfig = (vars) => {
  const saved = {};
  for (const key of CONFIG_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, vars);

  try {
    let loaded;
    jest.isolateModules(() => {
      loaded = require('../src/config/env');
    });
    return loaded;
  } finally {
    for (const key of CONFIG_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
};

/** The rest of a valid production environment, so each test varies one thing. */
const PRODUCTION_BASE = {
  NODE_ENV: 'production',
  DB_SOCKET_PATH: '/cloudsql/parentix:us-central1:parentix-prod-pg',
  DB_USER: 'parentix',
  JWT_SECRET: 'x'.repeat(64),
  FIELD_ENCRYPTION_KEY: 'a'.repeat(64),
  // A relay is part of a viable production boot, not an extra: signup cannot
  // complete without the emailed code, so an API that cannot send mail accepts
  // registrations and strands every one of them. See the SMTP_HOST case in
  // tests/signInHardening.test.js for the refusal itself.
  SMTP_HOST: 'smtp.example.com',
};

describe('CORS origins', () => {
  it('uses the localhost defaults in development', () => {
    const { env } = loadConfig({ NODE_ENV: 'development' });

    expect(env.corsOrigins).toEqual(['http://localhost:3000', 'http://localhost:3001']);
  });

  it('withholds the localhost defaults in production', () => {
    const { env } = loadConfig({
      ...PRODUCTION_BASE,
      CLIENT_URL: 'https://app.parentix.ca',
      ADMIN_URL: 'https://admin.parentix.ca',
    });

    expect(env.corsOrigins).toEqual(['https://app.parentix.ca', 'https://admin.parentix.ca']);
    expect(env.corsOrigins.join(' ')).not.toMatch(/localhost/);
  });

  it('never lets a deployed service inherit a localhost origin', () => {
    // The failure this guards: with a localhost default applied unconditionally,
    // a production boot that forgot CLIENT_URL would serve happily and accept
    // credentialed requests from a page on any developer's machine.
    const { env } = loadConfig({ ...PRODUCTION_BASE, NODE_ENV: 'production' });

    expect(env.corsOrigins).toEqual([]);
  });

  it('appends CORS_ORIGINS and drops duplicates', () => {
    // Without a custom domain both web apps are served from the same bucket
    // host, so the identical origin arrives from CLIENT_URL and ADMIN_URL both.
    const { env } = loadConfig({
      ...PRODUCTION_BASE,
      CLIENT_URL: 'https://storage.googleapis.com',
      ADMIN_URL: 'https://storage.googleapis.com',
      CORS_ORIGINS: 'https://staging.parentix.ca/, https://app.parentix.ca',
    });

    expect(env.corsOrigins).toEqual([
      'https://storage.googleapis.com',
      'https://staging.parentix.ca',
      'https://app.parentix.ca',
    ]);
  });
});

describe('assertProductionConfig', () => {
  it('accepts a fully configured production environment', () => {
    const { assertProductionConfig } = loadConfig({
      ...PRODUCTION_BASE,
      CLIENT_URL: 'https://app.parentix.ca',
      ADMIN_URL: 'https://admin.parentix.ca',
    });

    expect(() => assertProductionConfig()).not.toThrow();
  });

  it('refuses to start when CLIENT_URL is missing', () => {
    const { assertProductionConfig } = loadConfig(PRODUCTION_BASE);

    expect(() => assertProductionConfig()).toThrow(/CLIENT_URL/);
  });

  it.each([
    ['JWT_SECRET', { JWT_SECRET: 'too-short' }, /JWT_SECRET/],
    ['FIELD_ENCRYPTION_KEY', { FIELD_ENCRYPTION_KEY: 'not-hex' }, /FIELD_ENCRYPTION_KEY/],
    ['DB_USER alongside a socket', { DB_USER: '' }, /DB_USER/],
  ])('refuses to start on an invalid %s', (_label, override, expected) => {
    const { assertProductionConfig } = loadConfig({
      ...PRODUCTION_BASE,
      CLIENT_URL: 'https://app.parentix.ca',
      ...override,
    });

    expect(() => assertProductionConfig()).toThrow(expected);
  });

  it('refuses to start without a Postgres connection', () => {
    const { assertProductionConfig } = loadConfig({
      ...PRODUCTION_BASE,
      DB_SOCKET_PATH: '',
      CLIENT_URL: 'https://app.parentix.ca',
    });

    expect(() => assertProductionConfig()).toThrow(/Postgres connection/);
  });

  it('does nothing outside production', () => {
    const { assertProductionConfig } = loadConfig({ NODE_ENV: 'development' });

    expect(() => assertProductionConfig()).not.toThrow();
  });

  /**
   * SMS_ECHO_CODE returns the sign-in code in the HTTP response. `env.sms.echoCode`
   * already reads false in production whatever this is set to, so the boot could
   * safely continue — and that is precisely why it must not. An operator who set
   * it believes codes are being echoed and is wrong about the effect, not the
   * intent; a refused boot is how they find out before it matters.
   */
  it('refuses to start when SMS_ECHO_CODE is set in production', () => {
    const { assertProductionConfig } = loadConfig({
      ...PRODUCTION_BASE,
      CLIENT_URL: 'https://app.parentix.ca',
      SMS_ECHO_CODE: 'true',
    });

    expect(() => assertProductionConfig()).toThrow(/SMS_ECHO_CODE/);
  });
});

describe('SMS configuration', () => {
  it('echoes the code by default in development, never in production', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).env.sms.echoCode).toBe(true);
    expect(
      loadConfig({ ...PRODUCTION_BASE, CLIENT_URL: 'https://app.parentix.ca' }).env.sms.echoCode
    ).toBe(false);
  });

  /**
   * Terraform seeds every supplied secret with a single space, because Secret
   * Manager will not store an empty payload. That space is truthy: read
   * directly, it selected the 'twilio' provider on a deployment that had been
   * given no credentials at all — the same trap that made a blank SMTP host
   * read as configured and turned "password reset does not work" into a silent
   * failure.
   */
  it('reads an unsupplied Secret Manager placeholder as no provider at all', () => {
    const { env: loaded } = loadConfig({ NODE_ENV: 'development', TWILIO_ACCOUNT_SID: ' ' });

    expect(loaded.sms.provider).toBe('none');
    expect(loaded.sms.accountSid).toBe('');
  });
});
