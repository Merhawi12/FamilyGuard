#!/usr/bin/env node
/**
 * Runs the Jest suite against PostgreSQL instead of the default in-memory
 * SQLite.
 *
 * The two engines are not interchangeable, and the differences are silent: a
 * `json` column has no equality operator in Postgres but is plain text in
 * SQLite, identifiers fold differently, and stricter type checking rejects
 * comparisons SQLite happily coerces. A green SQLite run therefore says nothing
 * about whether Cloud SQL will accept the same statements — this script is how
 * that gap gets closed before a deploy rather than during one.
 *
 *   TEST_DATABASE_URL=postgresql://user:pass@host:5432/parentix_test npm run test:pg
 *
 * Point it at a throwaway database: every test file starts by dropping and
 * recreating the whole schema.
 */
const { spawnSync } = require('node:child_process');

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error(
    'TEST_DATABASE_URL is not set.\n\n' +
      '  Set it to a throwaway Postgres database, e.g.\n' +
      '    postgresql://parentix:secret@127.0.0.1:5432/parentix_test\n\n' +
      '  Every test file runs sync({ force: true }), so this database WILL be wiped.'
  );
  process.exit(2);
}

if (!/^postgres(ql)?:\/\//.test(url)) {
  console.error(`TEST_DATABASE_URL must be a postgres:// URL — got: ${url}`);
  process.exit(2);
}

console.log(`Running the suite against Postgres at ${url.replace(/\/\/[^@]*@/, '//***@')}\n`);

const result = spawnSync('npx', ['jest', '--runInBand', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});

process.exit(result.status === null ? 1 : result.status);
