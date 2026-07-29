#!/usr/bin/env node
/**
 * Creates or promotes a staff account.
 *
 * The Admin Dashboard has no sign-up — the first staff account has to come from
 * somewhere, and hand-editing the database is not it. Run this locally against
 * a .env, or as a one-off ECS task against production.
 *
 *   node scripts/create-admin.js --email you@example.com --name "Your Name"
 *   node scripts/create-admin.js --email you@example.com --role support
 *   echo 'secret' | node scripts/create-admin.js --email you@example.com --password-stdin
 *   ADMIN_PASSWORD=secret node scripts/create-admin.js --email you@example.com
 *
 * With no password supplied a strong one is generated and printed once. The
 * account is created already email-verified, since there is no inbox step for
 * staff.
 *
 * Prefer --password-stdin or ADMIN_PASSWORD over --password: an argument is
 * visible in shell history and in `ps` output to every other user on the host
 * for as long as the process runs.
 */
const crypto = require('node:crypto');
const { sequelize } = require('../src/config/db');
const { env } = require('../src/config/env');
const { User } = require('../src/models');

const ROLES = ['admin', 'support'];

const USAGE = `Usage:
  node scripts/create-admin.js --email <address> [--name "Full Name"] [--role admin|support]

Password (optional — one is generated and printed if omitted):
  --password-stdin        read it from stdin        (preferred)
  ADMIN_PASSWORD=...      read it from the environment
  --password <value>      discouraged: visible in shell history and ps output`;

const parseArgs = (argv) => {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    args[key] = next && !next.startsWith('--') ? (i += 1, next) : true;
  }
  return args;
};

/** Satisfies the password policy (length + letter + digit) by construction. */
const generatePassword = () =>
  `Px${crypto.randomBytes(12).toString('base64url').replace(/[^A-Za-z0-9]/g, '')}${crypto.randomInt(10, 100)}`;

const readStdin = () =>
  new Promise((resolve, reject) => {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
    });
    process.stdin.on('end', () => resolve(buffer));
    process.stdin.on('error', reject);
  });

/**
 * @returns {{ value: string, supplied: boolean }} `supplied` is false when the
 * value was generated here, which is what decides whether to print it and
 * whether promoting an existing account should touch its password at all.
 */
const resolvePassword = async (args) => {
  if (args['password-stdin']) {
    const value = (await readStdin()).replace(/\r?\n$/, '');
    if (!value) {
      console.error('--password-stdin was given but stdin was empty.');
      process.exit(2);
    }
    return { value, supplied: true };
  }

  if (process.env.ADMIN_PASSWORD) return { value: process.env.ADMIN_PASSWORD, supplied: true };

  if (typeof args.password === 'string') {
    console.warn(
      'Warning: --password is visible in shell history and in `ps` output.\n' +
        '         Prefer --password-stdin or the ADMIN_PASSWORD environment variable.\n' +
        '         Treat this password as compromised and change it after signing in.\n'
    );
    return { value: args.password, supplied: true };
  }

  return { value: generatePassword(), supplied: false };
};

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  const email = typeof args.email === 'string' ? args.email.trim().toLowerCase() : '';
  const role = typeof args.role === 'string' ? args.role : 'admin';

  if (args.help || !email || !email.includes('@')) {
    console.error(USAGE);
    process.exit(2);
  }

  if (!ROLES.includes(role)) {
    console.error(`--role must be one of: ${ROLES.join(', ')}`);
    process.exit(2);
  }

  const { value: password, supplied } = await resolvePassword(args);

  if (password.length < env.auth.minPasswordLength || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    console.error(
      `The password must be at least ${env.auth.minPasswordLength} characters and contain a letter and a digit.`
    );
    process.exit(2);
  }

  await sequelize.authenticate();

  const existing = await User.findOne({ where: { email } });

  if (existing) {
    // Promoting an existing account leaves its password alone unless one was
    // explicitly supplied — an operator running this twice should not silently
    // lock the person out.
    //
    // The failed-login lockout is always cleared: this script is the recovery
    // path, and resetting someone's password only to leave them locked out for
    // another 15 minutes is not a useful outcome.
    const wasLocked = !!existing.lockedUntil && new Date() < new Date(existing.lockedUntil);
    const updates = { role, isActive: true, emailVerified: true, failedLoginAttempts: 0, lockedUntil: null };
    if (supplied) updates.passwordHash = password;

    await existing.update(updates);
    console.log(`Updated ${email}: role=${role}, active, verified.`);
    if (wasLocked) console.log('Cleared the failed-login lockout.');
    console.log(supplied ? 'Password was reset to the value you supplied.' : 'Password unchanged.');
  } else {
    await User.create({
      name: typeof args.name === 'string' ? args.name : 'Parentix Staff',
      email,
      passwordHash: password, // hashed by the model hook
      role,
      plan: 'family',
      isActive: true,
      emailVerified: true,
    });

    console.log(`Created ${email} with role ${role}.`);
    if (!supplied) {
      console.log('\n  Generated password (shown once — store it in a password manager):\n');
      console.log(`      ${password}\n`);
    }
  }

  console.log('Sign in at the Admin Dashboard. Enable MFA from the Family App settings straight away.');
  await sequelize.close();
};

run().catch(async (err) => {
  console.error('Failed:', err.message);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
