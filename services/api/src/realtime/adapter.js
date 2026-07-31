const { env } = require('../config/env');
const logger = require('../utils/logger');

/**
 * Fans Socket.IO events out across every API instance via Memorystore Redis.
 *
 * Without this a parent connected to instance A never receives an event emitted
 * by instance B, so the service could only ever run a single instance. With
 * REDIS_URL unset
 * (local development, tests) the in-memory adapter is used and nothing breaks.
 *
 * @returns {Promise<null|() => Promise<void>>} a disconnect function, or null.
 */
const attachRedisAdapter = async (io) => {
  if (!env.redisUrl) {
    logger.info('Socket.IO using in-memory adapter (REDIS_URL not set)');
    return null;
  }

  const { createClient } = require('redis');
  const { createAdapter } = require('@socket.io/redis-adapter');

  const pubClient = createClient({ url: env.redisUrl });
  const subClient = pubClient.duplicate();

  pubClient.on('error', (err) => logger.error('Redis publisher error', { error: err.message }));
  subClient.on('error', (err) => logger.error('Redis subscriber error', { error: err.message }));

  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));
  logger.info('Socket.IO using Redis adapter');

  return async () => {
    await Promise.allSettled([pubClient.quit(), subClient.quit()]);
  };
};

module.exports = { attachRedisAdapter };
