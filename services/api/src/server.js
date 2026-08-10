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
    // Without a relay the API still answers "a reset link has been sent" — it
    // has to, or the endpoint would enumerate accounts — so a missing SMTP host
    // is invisible from the outside and password reset simply never completes.
    mail: mailIsEnabled() ? `smtp ${env.email.smtp.host}` : 'DISABLED — password reset and email verification cannot complete',
  });

  if (env.isProduction && !mailIsEnabled()) {
    logger.error('No SMTP relay configured. Set the smtp-host secret and redeploy — see docs/DEPLOYMENT.md §1.7.');
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
