const { env } = require('../config/env');

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const threshold = LEVELS[env.logLevel] ?? LEVELS.info;

/**
 * One JSON object per line so CloudWatch Logs Insights can query fields
 * directly; plain text locally where a human is reading the terminal.
 */
const emit = (level, message, meta) => {
  if (LEVELS[level] > threshold) return;

  if (env.isProduction) {
    const line = { level, message, time: new Date().toISOString(), ...meta };
    (level === 'error' ? console.error : console.log)(JSON.stringify(line));
    return;
  }

  const suffix = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  (level === 'error' ? console.error : console.log)(`[${level}] ${message}${suffix}`);
};

module.exports = {
  error: (message, meta) => emit('error', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  info: (message, meta) => emit('info', message, meta),
  debug: (message, meta) => emit('debug', message, meta),
};
