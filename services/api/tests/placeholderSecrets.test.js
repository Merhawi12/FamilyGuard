/**
 * Terraform seeds every externally-supplied secret with a single space, because
 * Cloud Run needs a version to mount and Secret Manager will not store an empty
 * one. Nothing about that space says "unsupplied" to a `!!value` check.
 *
 * The failure it caused was invisible: the mailer built an SMTP transport aimed
 * at the host " ", every send threw into the catch that keeps a notification
 * from failing its request, and the fallback that logs the reset link instead
 * was skipped — because the service believed it was configured. Users were told
 * a reset link had been sent and none ever arrived.
 *
 * So these assert the whitespace case specifically, not just the empty one.
 */
jest.mock('dotenv', () => ({ config: () => ({ parsed: {} }) }));

const KEYS = ['EMAIL_PROVIDER', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'];

const load = (vars) => {
  const saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, vars);
  try {
    let mod;
    jest.isolateModules(() => {
      mod = { env: require('../src/config/env').env, mailer: require('../src/services/mailer') };
    });
    return mod;
  } finally {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
};

describe('an unsupplied secret reads as unconfigured', () => {
  it('treats a single-space SMTP host as no host at all', () => {
    const { env } = load({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: ' ' });

    expect(env.email.smtp.host).toBe('');
  });

  it('reports email as disabled when the SMTP host is only whitespace', () => {
    // The bug in one line: this used to be true, so sendPasswordResetEmail took
    // the "real provider" branch and threw into a swallowed catch.
    const { mailer } = load({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: '  ' });

    expect(mailer.isEnabled()).toBe(false);
  });

  it('still reports email as enabled for a real host', () => {
    const { mailer } = load({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.sendgrid.net' });

    expect(mailer.isEnabled()).toBe(true);
  });

  it('trims a host that arrives with stray whitespace rather than rejecting it', () => {
    const { env } = load({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: ' smtp.sendgrid.net\n' });

    expect(env.email.smtp.host).toBe('smtp.sendgrid.net');
  });

  it('blanks whitespace-only SMTP credentials', () => {
    const { env } = load({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.com', SMTP_USER: ' ', SMTP_PASS: ' ' });

    expect(env.email.smtp.user).toBe('');
    expect(env.email.smtp.pass).toBe('');
  });

  /*
   * The second time this happened, the space was not the problem — the secret
   * had a real version, holding the template's own words. Production ran for
   * over a week with SMTP_USER set to `your-smtp-username`: the host was real,
   * every check passed, and the relay answered `535 Authentication failed` to
   * every verification and reset email. A value nobody supplied is unsupplied
   * whether it arrives as a space or as a sentence telling you to replace it.
   */
  it('treats a template placeholder username as no username at all', () => {
    const { env } = load({
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp-relay.brevo.com',
      SMTP_USER: 'your-smtp-username',
      SMTP_PASS: 'your-smtp-password',
    });

    expect(env.email.smtp.user).toBe('');
    expect(env.email.smtp.pass).toBe('');
  });

  it('leaves a credential that merely starts with a word alone', () => {
    // The placeholder pattern anchors on `your-` / `your_`, so an ordinary
    // credential is not blanked by looking vaguely like one.
    const { env } = load({
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp-relay.brevo.com',
      SMTP_USER: 'yourcompany@parentix.ca',
      SMTP_PASS: 'xsmtpsib-abc123',
    });

    expect(env.email.smtp.user).toBe('yourcompany@parentix.ca');
    expect(env.email.smtp.pass).toBe('xsmtpsib-abc123');
  });

  it('treats whitespace-only VAPID keys as absent, so push reports itself unavailable', () => {
    const { env } = load({ VAPID_PUBLIC_KEY: ' ', VAPID_PRIVATE_KEY: ' ' });

    expect(env.push.vapidPublicKey).toBe('');
    expect(env.push.vapidPrivateKey).toBe('');
  });
});
