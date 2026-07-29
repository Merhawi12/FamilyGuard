const { Sequelize } = require('sequelize');
const { env } = require('./env');

/**
 * PostgreSQL (RDS) in every deployed environment; SQLite locally and in tests so
 * the suite runs without any external service.
 */
const sequelize = env.db.usePostgres
  ? new Sequelize(env.db.url, {
      dialect: 'postgres',
      logging: env.db.logging ? console.log : false,
      pool: { max: env.db.poolMax, min: 0, acquire: 30000, idle: 10000 },
      // RDS terminates TLS with an AWS-issued certificate. Verifying it needs the
      // RDS CA bundle inside the image, so strict verification is opt-in via
      // DB_SSL_REJECT_UNAUTHORIZED once that bundle is installed.
      dialectOptions: env.db.ssl
        ? { ssl: { require: true, rejectUnauthorized: env.db.sslRejectUnauthorized } }
        : {},
      retry: { max: 3 },
    })
  : new Sequelize({
      dialect: 'sqlite',
      storage: env.db.sqlitePath,
      logging: env.db.logging ? console.log : false,
    });

module.exports = { sequelize };
