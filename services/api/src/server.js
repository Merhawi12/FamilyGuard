const { env, assertProductionConfig } = require('./config/env');
const logger = require('./utils/logger');
const { isEnabled: mailIsEnabled } = require('./services/mailer');
const { app, httpServer, io } = require('./app');
const { initializeDatabase, sequelize } = require('./db');
const { attachRedisAdapter } = require('./realtime/adapter');
const { startSafetyAnalysisJob } = require('./jobs/safetyAnalysis');
const { flushBackground } = require('./utils/background');

// A rejected promise nobody handled leaves the process in an unknown state.
// Log it loudly; Cloud Run replaces the instance if it then fails its probe.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { error: reason instanceof Error ? reason.message : String(reason) });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — shutting down', { error: err.message, stack: err.stack });
  process.exit(1);
});

const start = async () => {
  // First line out of the process, before anything that can block.
  //
  // Everything up to listen() used to be silent, so a stalled database
  // connection looked identical to a container that never ran: no logs, no
  // port, and a platform timeout with nothing to go on. This line proves Node
  // started and shows what it is about to connect to.
  logger.info('Starting Parentix API', {
    env: env.NODE_ENV,
    node: process.version,
    port: env.port,
    db: env.db.socketPath ? `socket ${env.db.socketPath}` : env.db.usePostgres ? 'postgres (tcp)' : 'sqlite',
    redis: env.redisUrl ? 'enabled' : 'disabled',
    // Stated at boot because the alternative is finding out from a customer.
    // Without a relay the API still answers "if an account exists … we have sent
    // a code" — it has to, or the endpoint would enumerate accounts — so a
    // missing SMTP host is invisible from the outside and password reset simply
    // never completes.
    mail: mailIsEnabled() ? `smtp ${env.email.smtp.host}` : 'DISABLED — password reset and email verification cannot complete',
    // Said at boot for the same reason as the line above, and with more urgency:
    // this one decides whether anybody can sign in at all.
    loginCode: env.auth.loginCodeRequired ? 'required on every password sign-in' : 'OFF',
  });

  if (env.isProduction && !mailIsEnabled()) {
    logger.error('No SMTP relay configured. Set the smtp-host secret and redeploy — see docs/DEPLOYMENT.md §1.7.');
  }

  /**
   * A Stripe credential that cannot be what it is named, said at boot.
   *
   * Not fatal, and not silent. It is not fatal because billing is the one
   * subsystem this product survives without — refusing to start would turn a
   * broken Upgrade button into a total outage, which is the worse trade. It is
   * not silent because the value has been read as absent, so from the outside
   * this deployment now looks like one that simply never configured Stripe:
   * `/auth/providers` reports `billing: false` and the Upgrade buttons are gone.
   * That is the honest state, but an operator who pasted a key ten minutes ago
   * needs to be told it was the wrong one rather than left to conclude their
   * change did not take.
   *
   * Logged in every environment, not only production. This is exactly the
   * mistake somebody makes while setting Stripe up on their laptop.
   */
  for (const problem of env.stripe.problems) {
    logger.error(`Stripe is misconfigured and has been ignored: ${problem}`);
  }

  /**
   * The combination that locks the whole product, stated in one sentence.
   *
   * Each half is a supported configuration. Together they are not: every
   * password sign-in is answered with a code that is written to this log and
   * sent nowhere, so the code screen is real, the code exists, and the only
   * person who can read it is whoever is tailing Cloud Run. Neither of the two
   * warnings above says that — the mail one talks about signup and password
   * reset, which were the whole story before the second factor existed.
   *
   * Fixed either way round: configure the relay, or set `LOGIN_CODE_REQUIRED=0`
   * until it is configured. The switch exists for exactly this, and this line is
   * what stops the choice being made after the support calls start.
   */
  if (env.isProduction && env.auth.loginCodeRequired && !mailIsEnabled()) {
    logger.error(
      'LOGIN_CODE_REQUIRED is on and there is no mail relay: every password sign-in will be '
      + 'answered with a code nobody can receive, so nobody can sign in. Configure SMTP, or set '
      + 'LOGIN_CODE_REQUIRED=0 until it is configured.',
    );
  }

  /**
   * The contact form has a destination, or nobody is reading it.
   *
   * Loud, and deliberately not fatal. The landing page offers a contact form to
   * every visitor unconditionally, and `ADMIN_EMAIL` is what decides whether a
   * human is told about a submission — so an unset value means a public form
   * that silently fills a table nobody looks at. That is worth shouting about on
   * every boot.
   *
   * It is not worth refusing to start over, and the reason is the change that
   * makes this line possible: submissions are stored before they are mailed
   * (see contactFormController), so an unconfigured mailbox delays messages
   * rather than destroying them. Blocking a deploy over a recoverable
   * misconfiguration would be the more expensive mistake — SMTP above is fatal
   * precisely because signup genuinely cannot complete without it.
   */
  if (env.isProduction && !env.email.adminAddress) {
    logger.error(
      'ADMIN_EMAIL is not set. Contact-form messages will be stored but nobody will be notified — '
      + 'set the admin_email Terraform variable and redeploy.',
    );
  }

  /**
   * A TLS connection to the database that verifies nothing, said out loud.
   *
   * `DB_SSL` on with `rejectUnauthorized` off encrypts the link and accepts any
   * certificate on the other end of it, which means the transport is confidential
   * against a passive listener and worthless against anything that can answer on
   * that address — and what it would be handed is the database password followed
   * by every query. Supplying DB_SSL_CA turns verification on by itself (see
   * `env.db.sslCa`), so this line exists to make the gap between the two states
   * visible rather than to nag.
   *
   * Not fatal, and not for the usual reason: the recommended topology is the
   * Cloud SQL Unix socket, where the connection never leaves the instance
   * sandbox and TLS is not in the picture at all. This only concerns TCP.
   */
  if (env.isProduction && env.db.ssl && !env.db.sslRejectUnauthorized) {
    logger.warn(
      'Database TLS is not verifying the server certificate. Set the db-ssl-ca secret to the '
      + "instance's server CA (gcloud sql instances describe <instance> "
      + "--format='value(serverCaCert.cert)') — see docs/DEPLOYMENT.md.",
    );
  }

  assertProductionConfig();

  await initializeDatabase();

  const disconnectRedis = await attachRedisAdapter(io);

  /**
   * The in-process timer, unless something outside is driving the job instead.
   *
   * On Cloud Run that something is Cloud Scheduler (JOB_RUNNER=external), which
   * calls /api/tasks/safety-analysis once an hour. Leaving the timer running as
   * well would duplicate the pass on every warm instance; leaving it as the only
   * runner would mean it never fires at all on a service scaled to zero.
   */
  const externalRunner = env.jobs.runner === 'external';
  const stopSafetyJob = externalRunner ? () => {} : startSafetyAnalysisJob(io);
  logger.info('Safety analysis scheduling', {
    runner: env.jobs.runner,
    ...(externalRunner && { endpoint: 'POST /api/tasks/safety-analysis' }),
  });

  await new Promise((resolve) => httpServer.listen(env.port, resolve));
  logger.info('Parentix API listening', { port: env.port, env: env.NODE_ENV });

  /**
   * Cloud Run sends SIGTERM and waits before SIGKILL. Stop accepting new work, let
   * in-flight requests finish, then release the socket and database handles.
   */
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });

    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 15000);
    forceExit.unref();

    stopSafetyJob();
    await new Promise((resolve) => httpServer.close(resolve));
    io.close();

    /**
     * Before the database goes, not after.
     *
     * Sign-in notices and password-changed confirmations are deliberately not
     * awaited by the request that starts them, so at SIGTERM there is usually
     * some in flight. Closing the connection underneath them turns a routine
     * redeploy into silently dropped security mail — the one class of message
     * whose whole purpose is to arrive.
     */
    await flushBackground();

    if (disconnectRedis) await disconnectRedis();
    await sequelize.close().catch(() => {});

    clearTimeout(forceExit);
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

if (require.main === module) {
  start().catch((err) => {
    logger.error('Failed to start server', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

module.exports = { start, app, httpServer, io };
