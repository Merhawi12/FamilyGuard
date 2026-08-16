/**
 * `dangerous_content`, raised from something the platform already knows.
 *
 * The alert type existed, the console listed it as one of the platform's rules,
 * the family app offered a preference for it — and nothing anywhere raised it.
 * The socket handler waited on an `alert:dangerous_content` the device has never
 * sent and could not: classifying a page as dangerous needs to see the page, and
 * the phone sees DNS names.
 *
 * But DNS names are enough for the part that matters. `contentCategories.js`
 * already maps a domain to a category, the device already reports every domain
 * it resolves, and `categoryForDomain` already matches the way the device
 * matches — so a lookup of an adult or gambling site is a fact the platform
 * holds and was throwing away.
 *
 * Two decisions worth stating:
 *
 * **It fires whether or not a filter stopped it.** Blocking is the parent's
 * configuration; the lookup is the child's behaviour. A parent who has not
 * switched on the adult-content category is exactly the parent who has not
 * learned they need to, and telling them only once they had already blocked it
 * would be telling them what they already knew.
 *
 * **Only categories where a single visit is worth an interruption.** Social
 * media, gaming and streaming are in the catalogue because a parent may wish to
 * *limit* them; alerting on one lookup of youtube.com would bury the two that
 * mean something. Blocked attempts on those still appear in web history and in
 * the Content Filtering report.
 */
const { Op } = require('sequelize');
const { Alert } = require('../models');
const { categoryForDomain, categoryLabel } = require('../config/contentCategories');
const { createAlert } = require('./alertHelper');
const logger = require('./logger');

/** Categories where one visit is news. See the note above. */
const RISKY_CATEGORIES = ['adult', 'gambling'];

/**
 * How long one alert speaks for.
 *
 * A single page load resolves a host many times and a browsing session revisits
 * it, so without this a child on one site could raise dozens of identical
 * high-severity alerts — each one an email and a push. Per category rather than
 * per domain: "an adult site" is the news, and the domains are in web history
 * for a parent who wants them.
 */
const ALERT_WINDOW_MS = 60 * 60 * 1000;

/** Has this child already been reported for this category recently? */
const recentlyAlerted = async (childId, category) => {
  const since = new Date(Date.now() - ALERT_WINDOW_MS);
  const recent = await Alert.findAll({
    where: { childId, type: 'dangerous_content', createdAt: { [Op.gte]: since } },
    attributes: ['metadata'],
  });
  return recent.some((row) => {
    try {
      return JSON.parse(row.metadata || '{}').category === category;
    } catch {
      return false;
    }
  });
};

/**
 * Raise `dangerous_content` for any risky category in a batch of resolved
 * domains.
 *
 * @param io          socket server, for the live broadcast
 * @param context     `{ parentId, childId, deviceId }`
 * @param domains     the domains in this batch, already normalised
 * @returns the categories actually alerted on, for the caller's logs
 */
const reportRiskyBrowsing = async (io, { parentId, childId, deviceId }, domains) => {
  const byCategory = new Map();
  for (const domain of domains) {
    const category = categoryForDomain(domain);
    if (!category || !RISKY_CATEGORIES.includes(category)) continue;
    // First domain of each category is the one named; the rest are counted.
    if (!byCategory.has(category)) byCategory.set(category, { domain, count: 0 });
    byCategory.get(category).count += 1;
  }
  if (byCategory.size === 0) return [];

  const raised = [];
  for (const [category, { domain, count }] of byCategory) {
    try {
      if (await recentlyAlerted(childId, category)) continue;

      const label = categoryLabel(category).toLowerCase();
      await createAlert(io, {
        parentId,
        childId,
        deviceId,
        type: 'dangerous_content',
        message: count > 1
          ? `A ${label} site was opened on a child device (${domain}, and ${count - 1} other${count === 2 ? '' : 's'})`
          : `A ${label} site was opened on a child device (${domain})`,
        severity: 'high',
        metadata: { category, domain, count },
      });
      raised.push(category);
    } catch (err) {
      // One category failing must not cost the others, and must never fail the
      // device's upload — the visits themselves are already stored.
      logger.error('Risky-browsing alert failed', { error: err.message, category, childId });
    }
  }
  return raised;
};

module.exports = { reportRiskyBrowsing, RISKY_CATEGORIES, ALERT_WINDOW_MS };
