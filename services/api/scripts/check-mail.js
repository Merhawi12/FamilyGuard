#!/usr/bin/env node
/**
 * Answers "is outbound mail actually working?" without guessing.
 *
 * Password reset and email verification are the two flows that cannot complete
 * without a relay, and neither says so from the outside: `/auth/forgot-password`
 * has to answer the same thing whether or not an account exists, so it answers
 * the same thing whether or not the message was sent. The only honest signal is
 * on the server, which is what this prints.
 *
 * Three levels, because each one fails differently and the difference is what
 * tells you where to look:
 *
 *   config    is a relay configured at all? (the placeholder trap: an unsupplied
 *             Secret Manager version is a single space, which used to read as
 *             a real host — see src/config/env.js)
 *   connect   does the relay accept a connection and the credentials? This is
 *             where an expired API key or a blocked port shows up.
 *   send      does a real message reach a real inbox? Nothing but a delivered
 *             message proves the whole chain.
 *
 *   node scripts/check-mail.js                       # config + connect
 *   node scripts/check-mail.js --to you@example.com  # …and send one
 *
 * On Cloud Run, run it against the deployed configuration rather than a local
 * .env — the values that matter live in Secret Manager:
 *
 *   gcloud run services proxy parentix-prod-api --region us-central1
 *   # or, to test the same credentials from anywhere:
 *   SMTP_HOST=$(gcloud secrets versions access latest --secret=parentix-prod-smtp-host) \
 *   SMTP_USER=$(gcloud secrets versions access latest --secret=parentix-prod-smtp-user) \
 *   SMTP_PASS=$(gcloud secrets versions access latest --secret=parentix-prod-smtp-pass) \
 *   EMAIL_PROVIDER=smtp node scripts/check-mail.js --to you@example.com
 *
 * Exits non-zero when mail is not working, so it can gate a release.
 */
const { env } = require('../src/config/env');
const { isEnabled } = require('../src/services/mailer');

const args = process.argv.slice(2);
const to = (() => {
  const i = args.indexOf('--to');
  return i !== -1 ? args[i + 1] : '';
})();

const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => console.log(`  ✗ ${msg}`);
const note = (msg) => console.log(`    ${msg}`);

const run = async () => {
  console.log('\nParentix mail check\n');

  // ── 1. Configuration ───────────────────────────────────────────────────────
  console.log('Configuration');
  const { provider, from } = env.email;
  const { host, port, secure, user } = env.email.smtp;

  console.log(`  EMAIL_PROVIDER : ${provider}`);
  console.log(`  SMTP_HOST      : ${host ? JSON.stringify(host) : '(empty)'}`);
  console.log(`  SMTP_PORT      : ${port}${secure ? ' (implicit TLS)' : ' (STARTTLS)'}`);
  console.log(`  SMTP_USER      : ${user ? JSON.stringify(user) : '(none — unauthenticated relay)'}`);
  console.log(`  SMTP_PASS      : ${env.email.smtp.pass ? `set, ${env.email.smtp.pass.length} chars` : '(empty)'}`);
  console.log(`  EMAIL_FROM     : ${from}`);
  console.log('');

  if (!isEnabled()) {
    bad('Mail is DISABLED. Nothing is being sent.');
    if (provider !== 'smtp') {
      note(`EMAIL_PROVIDER is "${provider}" — set it to "smtp".`);
    } else {
      note('EMAIL_PROVIDER is "smtp" but SMTP_HOST is empty after trimming.');
      note('An unsupplied Secret Manager version reads as a single space, which');
      note('is what this looks like. Add the real value and redeploy:');
      note('  printf \'smtp.example.net\' | gcloud secrets versions add parentix-prod-smtp-host --data-file=-');
    }
    console.log('\nPassword reset and email verification cannot complete in this state.\n');
    process.exit(1);
  }
  ok(`A relay is configured: ${host}:${port}`);

  // ── 2. Connection ──────────────────────────────────────────────────────────
  // nodemailer's own verify(): opens the connection, runs STARTTLS, and
  // authenticates — without sending anything. It separates "the relay is
  // unreachable" from "the relay rejected these credentials", which the send
  // path cannot, because `send()` swallows both into a logged false.
  console.log('\nConnection');
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass: env.email.smtp.pass } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
  });

  try {
    await transport.verify();
    ok('The relay accepted the connection and the credentials.');
  } catch (err) {
    bad(`The relay refused: ${err.message}`);
    if (/EAUTH|535|Invalid login/i.test(err.message)) {
      note('That is an authentication failure — SMTP_USER or SMTP_PASS is wrong,');
      note('or the API key was revoked. Most relays want the literal username');
      note('they document (SendGrid: "apikey", Resend: "resend") and the key as');
      note('the password.');
    } else if (/ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH/i.test(err.message)) {
      note('That is a network failure. Compute Engine blocks outbound port 25');
      note('permanently — use 587 (STARTTLS) or 465 (implicit TLS).');
    } else if (/ENOTFOUND|EAI_AGAIN/i.test(err.message)) {
      note(`The hostname ${host} does not resolve. Check SMTP_HOST for a typo.`);
    }
    console.log('');
    process.exit(1);
  }

  // ── 3. Delivery ────────────────────────────────────────────────────────────
  if (!to) {
    console.log('\nNo --to address given, so nothing was sent.');
    console.log('A relay that accepts a connection can still refuse or silently drop');
    console.log('a message — an unverified sender domain is the usual reason. Pass');
    console.log('--to <address> to prove the whole chain.\n');
    return;
  }

  console.log('\nDelivery');
  try {
    const info = await transport.sendMail({
      from,
      to,
      subject: 'Parentix mail check',
      text:
        'If you are reading this, outbound mail works: password reset links and '
        + 'signup verification codes will reach their recipients.\n\n'
        + `Sent from ${host}:${port} as ${from}.\n`,
    });
    ok(`The relay accepted the message for ${to}`);
    if (info.messageId) note(`Message-Id: ${info.messageId}`);
    if (info.response) note(`Relay said: ${info.response}`);
    console.log('\nAccepted is not the same as delivered. Check the inbox, and check');
    console.log('spam — a domain with no SPF/DKIM records lands there. docs/DEPLOYMENT.md');
    console.log('§1.6 has the records to add.\n');
  } catch (err) {
    bad(`The relay rejected the message: ${err.message}`);
    if (/from|sender|domain|550|553/i.test(err.message)) {
      note(`EMAIL_FROM is ${from}. Most relays refuse to send as a domain you`);
      note('have not verified with them — do the "domain authentication" step in');
      note('the relay\'s dashboard, which is also what produces the DKIM records.');
    }
    console.log('');
    process.exit(1);
  }
};

run().catch((err) => {
  console.error(`\nUnexpected failure: ${err.message}\n`);
  process.exit(1);
});
