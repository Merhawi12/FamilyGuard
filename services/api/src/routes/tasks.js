const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const { env } = require('../config/env');
const { runOnce } = require('../jobs/safetyAnalysis');
const logger = require('../utils/logger');

/**
 * Endpoints driven by Cloud Scheduler rather than by a user.
 *
 * These are the same jobs the in-process timer runs when JOB_RUNNER=internal;
 * on Cloud Run the timer is off and Scheduler calls these instead. See
 * `env.jobs` for why the two runners exist.
 *
 * Authentication is not the usual JWT: the caller is a Google service account,
 * not a person. Cloud Scheduler attaches an OIDC identity token, and this
 * verifies the signature against Google's published keys, the audience, and the
 * email in the token. All three matter — a valid Google-signed token proves only
 * that *some* Google identity made the call, which is close to no proof at all.
 */

const router = express.Router();

// Reused across requests: the client caches Google's signing certificates, and
// fetching them on every call would add a round trip to each job run.
let oidcClient = null;

/**
 * Rejects anything that is not this project's scheduler.
 *
 * Returns 503 rather than 401 when no service account is configured. The
 * distinction is worth keeping: 401 says "you are not allowed", which invites a
 * retry with different credentials, while a deployment that was never told which
 * account to trust cannot be satisfied by any caller and should say so.
 */
const verifyScheduler = async (req, res, next) => {
  const expected = env.jobs.schedulerServiceAccount;
  if (!expected) {
    logger.error('Task endpoint called but SCHEDULER_SERVICE_ACCOUNT is unset', { path: req.path });
    return res.status(503).json({ error: 'Scheduled tasks are not configured' });
  }

  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    oidcClient = oidcClient || new OAuth2Client();
    const ticket = await oidcClient.verifyIdToken({
      idToken: token,
      // Cloud Scheduler mints the token for the audience named in the job. When
      // TASKS_AUDIENCE is unset, google-auth-library skips the audience check
      // and the email check below is the only thing standing between the caller
      // and the job — which is why Terraform always sets it.
      audience: env.jobs.tasksAudience || undefined,
    });

    const payload = ticket.getPayload();
    // `email_verified` is what separates a service-account token, where Google
    // vouches for the address, from a user token carrying a self-asserted one.
    if (!payload?.email_verified || payload.email !== expected) {
      logger.warn('Task endpoint rejected a token', {
        path: req.path,
        email: payload?.email || '(none)',
      });
      return res.status(403).json({ error: 'Forbidden' });
    }

    return next();
  } catch (err) {
    logger.warn('Task endpoint token verification failed', { path: req.path, error: err.message });
    return res.status(401).json({ error: 'Unauthorized' });
  }
};

router.use(verifyScheduler);

/**
 * The hourly pass over every active parent.
 *
 * Answers only once the pass has finished, so Cloud Scheduler's own retry and
 * its record of the outcome mean something. The job takes seconds for a fleet of
 * this size and Cloud Run allows an hour, so there is no need to acknowledge
 * early and run detached — and doing so would report success for work that had
 * not happened yet.
 */
router.post('/safety-analysis', async (req, res) => {
  const startedAt = Date.now();
  try {
    await runOnce(req.app.get('io'));
    const durationMs = Date.now() - startedAt;
    logger.info('Scheduled safety analysis finished', { durationMs });
    res.json({ status: 'ok', durationMs });
  } catch (err) {
    logger.error('Scheduled safety analysis failed', { error: err.message });
    // 500 so Scheduler retries rather than recording a success.
    res.status(500).json({ error: 'Safety analysis failed' });
  }
});

module.exports = router;
