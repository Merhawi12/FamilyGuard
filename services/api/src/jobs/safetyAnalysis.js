const { User } = require('../models');
const { analyzeParent } = require('../utils/safetyAnalyzer');
const logger = require('../utils/logger');

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Hourly pass over every active parent looking for risk patterns.
 *
 * Runs on all API tasks today. Because `analyzeParent` only raises an alert when
 * one does not already exist for the pattern, duplicate runs are harmless — but
 * if the fleet grows this belongs in a single scheduled task instead.
 */
const runOnce = async (io) => {
  const parents = await User.findAll({ where: { role: 'parent', isActive: true }, attributes: ['id'] });
  for (const parent of parents) {
    await analyzeParent(io, parent.id).catch((err) =>
      logger.error('Safety analysis failed for parent', { parentId: parent.id, error: err.message })
    );
  }
};

/** @returns {() => void} stops the schedule. */
const startSafetyAnalysisJob = (io, intervalMs = ONE_HOUR_MS) => {
  const timer = setInterval(() => {
    runOnce(io).catch((err) => logger.error('Safety analysis scheduler error', { error: err.message }));
  }, intervalMs);

  // Never hold the process open on shutdown.
  timer.unref?.();

  return () => clearInterval(timer);
};

module.exports = { startSafetyAnalysisJob, runOnce };
