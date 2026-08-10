#!/usr/bin/env node
/**
 * A throwaway PostgreSQL 16 for running the suite against the engine Cloud SQL
 * actually uses.
 *
 * The tests default to in-memory SQLite so that a checkout runs with no external
 * service, and that default hides real differences: `is_active` is an integer in
 * one engine and a boolean in the other, an `INSERT ... RETURNING` leaves a
 * Sequelize instance in a different state, `json` has no equality operator in
 * Postgres. Each of those has already produced a green SQLite run that said
 * nothing true about production.
 *
 * This manages a cluster that needs no administrator rights, no installer and no
 * Docker — the PostgreSQL project publishes the server as a plain zip, and a
 * cluster is a directory. Nothing here touches the machine outside
 * `PARENTIX_PG_HOME` (default `~/.tools`), and the cluster listens on 5433 so it
 * can never collide with a real install added later.
 *
 *   node scripts/local-postgres.mjs install   # download + unpack the binaries
 *   node scripts/local-postgres.mjs start     # init if needed, then start
 *   node scripts/local-postgres.mjs status
 *   node scripts/local-postgres.mjs stop
 *   node scripts/local-postgres.mjs url       # print the connection string
 *
 * `npm run test:pg` and `npm run test:browser:pg` are the two you want; both
 * start the cluster first. They spawn the run from here rather than putting a
 * `VAR=value` prefix in package.json, because npm runs scripts through cmd.exe
 * on Windows and that syntax is a POSIX-shell feature — it would fail on the one
 * platform this installer supports.
 */
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const PG_VERSION = '16.6-1';
// Matches `database_version = "POSTGRES_16"` in infrastructure/gcp/database.tf.
// Testing against a different major than production defeats the purpose.
const HOME = process.env.PARENTIX_PG_HOME || path.join(homedir(), '.tools');
const BIN = path.join(HOME, 'pg16', 'bin');
const DATA = path.join(HOME, 'pgdata16');
const PORT = process.env.PARENTIX_PG_PORT || '5433';
const USER = 'postgres';
const PASSWORD = 'parentix';

const DATABASES = ['parentix_test', 'parentix_browser'];

const url = (db = 'parentix_test') =>
  `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${db}`;

const exe = (name) => path.join(BIN, process.platform === 'win32' ? `${name}.exe` : name);

const run = (file, args, opts = {}) =>
  spawnSync(file, args, { encoding: 'utf8', ...opts });

const installed = () => existsSync(exe('pg_ctl'));

const die = (message) => {
  console.error(message);
  process.exit(1);
};

async function install() {
  if (installed()) {
    console.log(`Already installed at ${BIN}`);
    return;
  }
  if (process.platform !== 'win32') {
    die(
      'Automatic install is Windows-only (the zip below is the win-x64 build).\n'
      + 'On macOS/Linux use your package manager or Docker, then set TEST_DATABASE_URL yourself.'
    );
  }

  mkdirSync(HOME, { recursive: true });
  const zipUrl = `https://get.enterprisedb.com/postgresql/postgresql-${PG_VERSION}-windows-x64-binaries.zip`;
  const zip = path.join(HOME, `pg-${PG_VERSION}.zip`);

  console.log(`Downloading PostgreSQL ${PG_VERSION} (~290 MB)…`);
  const res = await fetch(zipUrl);
  if (!res.ok) die(`Download failed: HTTP ${res.status} from ${zipUrl}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));

  console.log('Unpacking…');
  // The archive's top-level directory is `pgsql`; renamed so several majors can
  // live side by side later.
  const unpack = run('powershell', [
    '-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${HOME}' -Force;`
    + `if (Test-Path '${path.join(HOME, 'pgsql')}') { Rename-Item '${path.join(HOME, 'pgsql')}' 'pg16' -Force }`,
  ]);
  if (unpack.status !== 0) die(`Unpack failed:\n${unpack.stderr || unpack.stdout}`);
  rmSync(zip, { force: true });

  if (!installed()) die(`Unpacked, but ${exe('pg_ctl')} is missing.`);
  console.log(`Installed to ${BIN}`);
}

function initCluster() {
  if (existsSync(path.join(DATA, 'PG_VERSION'))) return;

  console.log(`Initialising a cluster at ${DATA}…`);
  const pwfile = path.join(tmpdir(), `parentix-pg-${process.pid}`);
  writeFileSync(pwfile, PASSWORD);
  try {
    const init = run(exe('initdb'), [
      '-D', DATA, '-U', USER, `--pwfile=${pwfile}`, '--encoding=UTF8', '--locale=C',
    ]);
    if (init.status !== 0) die(`initdb failed:\n${init.stderr || init.stdout}`);
  } finally {
    rmSync(pwfile, { force: true });
  }

  // Off the default port, and reachable only from this machine. This is a
  // scratch cluster holding test fixtures; it has no business on a network.
  const confPath = path.join(DATA, 'postgresql.conf');
  const conf = readFileSync(confPath, 'utf8')
    .replace(/^#?port\s*=.*$/m, `port = ${PORT}`)
    .replace(/^#?listen_addresses\s*=.*$/m, "listen_addresses = 'localhost'");
  writeFileSync(confPath, conf);
}

const isRunning = () => run(exe('pg_ctl'), ['-D', DATA, 'status']).status === 0;

function psql(args, db = 'postgres') {
  return run(exe('psql'), ['-h', '127.0.0.1', '-p', PORT, '-U', USER, '-d', db, ...args], {
    env: { ...process.env, PGPASSWORD: PASSWORD },
  });
}

function start() {
  if (!installed()) die('Not installed. Run: node scripts/local-postgres.mjs install');
  initCluster();

  if (isRunning()) {
    console.log(`Already running on port ${PORT}`);
  } else {
    const started = run(exe('pg_ctl'), ['-D', DATA, '-l', path.join(DATA, 'server.log'), '-w', 'start']);
    if (started.status !== 0) die(`Could not start:\n${started.stderr || started.stdout}`);
    console.log(`Started on port ${PORT}`);
  }

  for (const db of DATABASES) {
    const exists = psql(['-tAc', `SELECT 1 FROM pg_database WHERE datname='${db}'`]);
    if (!exists.stdout.trim()) {
      const created = psql(['-c', `CREATE DATABASE ${db}`]);
      if (created.status !== 0) die(`Could not create ${db}:\n${created.stderr}`);
      console.log(`Created ${db}`);
    }
  }
}

function stop() {
  if (!installed() || !existsSync(path.join(DATA, 'PG_VERSION'))) return console.log('Nothing to stop.');
  if (!isRunning()) return console.log('Not running.');
  const stopped = run(exe('pg_ctl'), ['-D', DATA, '-m', 'fast', '-w', 'stop']);
  console.log(stopped.status === 0 ? 'Stopped.' : `Could not stop:\n${stopped.stderr || stopped.stdout}`);
}

function status() {
  console.log(`binaries : ${installed() ? BIN : 'NOT INSTALLED'}`);
  console.log(`cluster  : ${existsSync(path.join(DATA, 'PG_VERSION')) ? DATA : 'NOT INITIALISED'}`);
  console.log(`running  : ${installed() && isRunning() ? `yes (port ${PORT})` : 'no'}`);
  console.log(`url      : ${url()}`);
}

/**
 * Start the cluster, then hand the run its connection string.
 *
 * The cluster is deliberately left running afterwards. These suites get run
 * several times in a row while something is being chased down, and paying the
 * start-up on each one — or worse, having the previous run's cluster torn down
 * underneath a `--watch` — is the sort of friction that ends with people going
 * back to the SQLite default. `npm run pg:stop` when you are done.
 */
const runSuite = (which) => {
  start();

  if (which === 'test:browser') {
    /**
     * Dropped and recreated, because "throwaway" is load-bearing here.
     *
     * On SQLite the harness gets a brand-new temp file per run, and several of
     * its assertions are counts over the whole database — "Showing 1–50 of 72
     * users", the month's billing total. Handed a Postgres database that
     * survived the previous run they read the accumulated fixtures of both and
     * fail on the difference, which looks exactly like a pagination bug. The
     * Jest suite needs no equivalent: `tests/db.setup.js` already syncs with
     * `force: true` before every file.
     */
    const dropped = psql(['-c', 'DROP DATABASE IF EXISTS parentix_browser WITH (FORCE)']);
    if (dropped.status !== 0) die(`Could not reset parentix_browser:\n${dropped.stderr}`);
    const created = psql(['-c', 'CREATE DATABASE parentix_browser']);
    if (created.status !== 0) die(`Could not recreate parentix_browser:\n${created.stderr}`);
  }

  const [file, args, env] = which === 'test:api'
    ? ['npm', ['--prefix', 'services/api', 'run', 'test:pg'], { TEST_DATABASE_URL: url('parentix_test') }]
    : ['node', ['scripts/browser-e2e.mjs'], { BROWSER_E2E_DATABASE_URL: url('parentix_browser') }];

  const result = run(file, args, {
    stdio: 'inherit',
    encoding: undefined,
    shell: process.platform === 'win32', // npm is a .cmd on Windows
    env: { ...process.env, ...env },
  });
  process.exit(result.status ?? 1);
};

const command = process.argv[2] || 'status';

switch (command) {
  case 'install': await install(); break;
  case 'start': start(); break;
  case 'stop': stop(); break;
  case 'status': status(); break;
  case 'url': console.log(url(process.argv[3])); break;
  case 'test:api': runSuite('test:api'); break;
  case 'test:browser': runSuite('test:browser'); break;
  default:
    die(`Unknown command: ${command}\nUse install | start | stop | status | url | test:api | test:browser`);
}
