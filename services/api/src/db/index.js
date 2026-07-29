const { sequelize } = require('../config/db');
const { migrator } = require('./migrator');
const logger = require('../utils/logger');

require('../models'); // define every model + association before syncing

/**
 * Brings the database to the shape the running code expects:
 * creates any missing tables from the models, then applies pending migrations.
 */
const initializeDatabase = async ({ migrate = true } = {}) => {
  await sequelize.authenticate();
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
};

module.exports = { initializeDatabase, sequelize };
