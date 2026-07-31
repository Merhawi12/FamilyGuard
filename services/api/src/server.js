const { env, assertProductionConfig } = require('./config/env');
const logger = require('./utils/logger');
const { app, httpServer, io } = require('./app');
const { initializeDatabase, sequelize } = require('./db');
const { attachRedisAdapter } = require('./realtime/adapter');
const { startSafetyAnalysisJob } = require('./jobs/safetyAnalysis');

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
  assertProductionConfig();

  await initializeDatabase();

  const disconnectRedis = await attachRedisAdapter(io);
  const stopSafetyJob = startSafetyAnalysisJob(io);

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
