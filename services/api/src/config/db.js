const { Sequelize } = require('sequelize');
const { env } = require('./env');

/**
 * PostgreSQL (Cloud SQL) in every deployed environment; SQLite locally and in
 * tests so the suite runs without any external service.
 */

const common = {
  dialect: 'postgres',
  logging: env.db.logging ? console.log : false,
  pool: { max: env.db.poolMax, min: 0, acquire: 30000, idle: 10000 },
  retry: { max: 3 },
};

/**
 * Fail rather than hang when the server does not answer.
 *
 * Without a bound, a socket that exists but never completes a handshake — a
 * Cloud SQL instance still starting, say — leaves the boot blocked with nothing
 * logged, and the platform eventually kills the container for not opening its
 * port. An error after ten seconds is far easier to act on than an indefinite
 * stall, and Sequelize still retries three times on top of this.
 */
const CONNECT_TIMEOUT_MS = 10000;

/**
 * Cloud SQL over the Unix socket Cloud Run mounts at /cloudsql/<connection-name>.
 * pg selects socket mode when `host` is a filesystem path, so the socket goes in
 * `host` and `port` is left unset — passing a port here makes pg attempt TCP to
 * a hostname that does not resolve.
 */
const socketConfig = () => ({
  ...common,
  host: env.db.socketPath,
  database: env.db.name,
  username: env.db.user,
  password: env.db.password,
  dialectOptions: {
    host: env.db.socketPath,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  },
});

/**
 * Cloud SQL over private IP, or any other Postgres reachable by TCP.
 *
 * Cloud SQL presents a Google-issued certificate. Verifying it needs the
 * server-ca.pem in the image, so strict verification is opt-in via
 * DB_SSL_REJECT_UNAUTHORIZED once that file is installed.
 */
const urlConfig = () => ({
  ...common,
  dialectOptions: {
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    ...(env.db.ssl
      ? {
        ssl: {
          require: true,
          rejectUnauthorized: env.db.sslRejectUnauthorized,
          // Present only when DB_SSL_CA is configured; `ca: undefined` would
          // fall back to the system store, which does not contain Cloud SQL's
          // per-instance CA and so fails every connection.
          ...(env.db.sslCa ? { ca: env.db.sslCa } : {}),
        },
      }
      : {}),
  },
});

let sequelize;
if (env.db.socketPath) {
  sequelize = new Sequelize(socketConfig());
} else if (env.db.usePostgres) {
  sequelize = new Sequelize(env.db.url, urlConfig());
} else {
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: env.db.sqlitePath,
    logging: env.db.logging ? console.log : false,
  });
}

module.exports = { sequelize };
