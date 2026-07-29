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
 *   node scripts/create-admin.js --email you@example.com --password '...'
 *
 * With no --password a strong one is generated and printed once. The account is
 * created already email-verified, since there is no inbox step for staff.
 */
const crypto = require('node:crypto');
const { sequelize } = require('../src/config/db');
const { env } = require('../src/config/env');
const { User } = require('../src/models');

const ROLES = ['admin', 'support'];

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

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  const email = typeof args.email === 'string' ? args.email.trim().toLowerCase() : '';
  const role = typeof args.role === 'string' ? args.role : 'admin';

  if (!email || !email.includes('@')) {
    console.error('Usage: node scripts/create-admin.js --email <address> [--name "Full Name"] [--role admin|support] [--password <value>]');
    process.exit(2);
  }

  if (!ROLES.includes(role)) {
    console.error(`--role must be one of: ${ROLES.join(', ')}`);
    process.exit(2);
  }

  const password = typeof args.password === 'string' ? args.password : generatePassword();
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
    const updates = { role, isActive: true, emailVerified: true };
    if (typeof args.password === 'string') updates.passwordHash = password;

    await existing.update(updates);
    console.log(`Updated ${email}: role=${role}, active, verified.`);
    if (updates.passwordHash) console.log('Password was reset to the value you supplied.');
    else console.log('Password unchanged.');
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
    if (typeof args.password !== 'string') {
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
