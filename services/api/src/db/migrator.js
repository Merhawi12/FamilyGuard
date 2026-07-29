const path = require('node:path');
const { Umzug, SequelizeStorage } = require('umzug');
const { sequelize } = require('../config/db');
const logger = require('../utils/logger');

/**
 * Schema ownership is split deliberately:
 *
 * - Table creation comes from the Sequelize models via `sequelize.sync()`. It
 *   only ever CREATEs missing tables, so it is safe to run on every boot and the
 *   models stay the single source of truth for a table's shape.
 * - Everything sync cannot do safely — adding a column to a table that already
 *   exists, creating indexes, backfilling data — lives in a numbered migration
 *   here and is applied exactly once, tracked in the `migrations` table.
 */
const migrator = new Umzug({
  migrations: {
    glob: ['migrations/*.js', { cwd: __dirname }],
    resolve: ({ name, path: filepath, context }) => {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const migration = require(filepath);
      return {
        name,
        up: async () => migration.up(context),
        down: async () => (migration.down ? migration.down(context) : undefined),
      };
    },
  },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize, modelName: 'migrations' }),
  logger: {
    info: (message) => logger.info('[migration]', message),
    warn: (message) => logger.warn('[migration]', message),
    error: (message) => logger.error('[migration]', message),
    debug: () => {},
  },
});

module.exports = { migrator, migrationsPath: path.join(__dirname, 'migrations') };
