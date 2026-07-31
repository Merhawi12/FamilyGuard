const { sequelize } = require('../config/db');
const { env } = require('../config/env');
const { migrator } = require('./migrator');
const logger = require('../utils/logger');

require('../models'); // define every model + association before syncing

// Arbitrary but fixed: two tasks must pick the same number to contend for the
// same lock. Postgres advisory locks are keyed by this integer alone.
const MIGRATION_LOCK_ID = 87213401;

/**
 * Serialises schema work across API instances.
 *
 * Cloud Run can start several instances of a revision at once, so without this
 * they would all run `sync()` and the pending migrations simultaneously. The
 * advisory lock is session-scoped and released explicitly; if an instance dies
 * holding it, Postgres drops it when the connection closes.
 */
const withMigrationLock = async (work) => {
  if (!env.db.usePostgres) return work(); // SQLite runs single-process

  await sequelize.query('SELECT pg_advisory_lock(:id)', { replacements: { id: MIGRATION_LOCK_ID } });
  try {
    return await work();
  } finally {
    await sequelize
      .query('SELECT pg_advisory_unlock(:id)', { replacements: { id: MIGRATION_LOCK_ID } })
      .catch((err) => logger.error('Failed to release migration lock', { error: err.message }));
  }
};

/**
 * Brings the database to the shape the running code expects: creates any
 * missing tables from the models, then applies pending migrations.
 */
const initializeDatabase = async ({ migrate = true } = {}) => {
  await sequelize.authenticate();

  await withMigrationLock(async () => {
    await sequelize.sync();
    if (!migrate) return;

    const pending = await migrator.pending();
    if (!pending.length) {
      logger.info('Database schema up to date');
      return;
    }

    logger.info(`Applying ${pending.length} pending migration(s)`, { migrations: pending.map((m) => m.name) });
    await migrator.up();
    logger.info('Migrations applied');
  });
};

module.exports = { initializeDatabase, sequelize };
