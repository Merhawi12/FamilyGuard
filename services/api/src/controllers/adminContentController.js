const { Op, fn, col } = require('sequelize');
const { ActivityLog, WebsiteRule, Child, Device } = require('../models');
const { blindIndex } = require('../utils/crypto');
const { normalizeDomain } = require('../utils/domain');
const { countDistinct, countDistinctGrouped } = require('../utils/aggregate');
const { auditLog } = require('../utils/auditLogger');
const {
  CONTENT_CATEGORIES, CATEGORY_KEYS, categoryCatalogue, categoryForDomain, domainsForCategory,
} = require('../config/contentCategories');
const { getContentPolicy, setContentPolicy, policyStrength } = require('../utils/contentSettings');
const { normalizePolicy } = require('../utils/contentPolicy');

/**
 * The console's Content Filtering screen.
 *
 * Two halves that look alike and are not: the **policy** is something an
 * operator sets and every device is then subject to (`utils/contentSettings.js`,
 * expanded to domains in `utils/contentPolicy.js`), while the **summary** is a
 * report on what the fleet did with it. Everything in the summary is measured;
 * nothing here estimates.
 *
 * The blocked-attempt figures are real because the device has always reported
 * them — the DNS proxy answers NXDOMAIN for a blocked name and sends the flag
 * with the visit. Until migration 0010 the API dropped that flag on arrival, so
 * this screen is the first thing able to read it.
 */

const WINDOW_DAYS = 7;

/** How many domains the platform-wide list may hold. */
const MAX_DOMAIN_RULES = 500;

/**
 * Blocked lookups in the window, grouped by category.
 *
 * `url` is encrypted with a random IV, so it cannot be grouped in SQL — but
 * `url_hash` is the blind index over the same value, and a blocked lookup can
 * only ever be a domain some rule named. So the hashes of every domain the
 * platform knows about are computed up front and the counts are mapped back
 * through them. No row is decrypted, and a domain nothing recognises still
 * counts, under "Other".
 */
const blockedAttempts = async (policy) => {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const rows = await ActivityLog.findAll({
    where: { blocked: true, category: 'browsing', startTime: { [Op.gte]: since } },
    attributes: ['urlHash', [fn('SUM', col('visit_count')), 'attempts']],
    group: ['url_hash'],
    raw: true,
  });
  if (rows.length === 0) {
    return { total: 0, byCategory: CONTENT_CATEGORIES.map((c) => ({ key: c.key, label: c.label, attempts: 0 })), topDomains: [] };
  }

  // Every domain that could have been blocked: the catalogue, the platform's own
  // list, and whatever parents typed. One hash each, computed here rather than
  // per row.
  const known = new Set([
    ...CONTENT_CATEGORIES.flatMap((c) => c.domains),
    ...(policy.domainRules || []).map((r) => r.domain),
  ]);
  const parentRules = await WebsiteRule.findAll({
    where: { url: { [Op.ne]: null } }, attributes: ['url'], raw: true,
  });
  parentRules.forEach((r) => { const d = normalizeDomain(r.url); if (d) known.add(d); });

  const byHash = new Map([...known].map((domain) => [blindIndex(domain), domain]));

  const counts = new Map(CATEGORY_KEYS.map((key) => [key, 0]));
  let other = 0;
  const domainTotals = [];

  for (const row of rows) {
    const attempts = Number(row.attempts) || 0;
    const domain = byHash.get(row.urlHash);
    if (!domain) { other += attempts; continue; }

    domainTotals.push({ domain, attempts, category: categoryForDomain(domain) });
    const key = categoryForDomain(domain);
    if (key && counts.has(key)) counts.set(key, counts.get(key) + attempts);
    else other += attempts;
  }

  const byCategory = CONTENT_CATEGORIES.map((c) => ({ key: c.key, label: c.label, attempts: counts.get(c.key) || 0 }));
  if (other > 0) byCategory.push({ key: 'other', label: 'Other', attempts: other });

  return {
    total: byCategory.reduce((sum, c) => sum + c.attempts, 0),
    byCategory: byCategory.sort((a, b) => b.attempts - a.attempts),
    topDomains: domainTotals.sort((a, b) => b.attempts - a.attempts).slice(0, 8),
  };
};

/**
 * What the policy actually covers, and what families have built on top of it.
 *
 * Every figure is a count of rows, not a projection: a device is "enforcing" if
 * it is linked and active, because that is the population that fetches rules.
 */
const coverage = async () => {
  /**
   * Six aggregates rather than one table scan.
   *
   * This used to select every website rule on the platform with four columns
   * projected and derive all five figures from the array with `Set` and
   * `filter().length`. Every one of them is a `COUNT` the database can do
   * without sending a row back, and the array grows with every rule any parent
   * has ever written while the answer stays five integers.
   *
   * `url: null` is the exact SQL equivalent of the `!r.url` test it replaces:
   * `addWebsiteRule` stores either NULL or a normalised non-empty hostname, so
   * there are no empty strings for the two to disagree about.
   */
  const [children, devices, childrenWithRules, categoryChildren, customDomains, allowances] =
    await Promise.all([
      Child.count(),
      Device.count({ where: { isActive: true, isLinked: true } }),
      countDistinct(WebsiteRule, 'childId'),
      countDistinctGrouped(WebsiteRule, 'category', 'childId', { url: null }),
      WebsiteRule.count({ where: { url: { [Op.not]: null }, action: 'block' } }),
      WebsiteRule.count({ where: { action: 'allow' } }),
    ]);

  const categoryUsage = CONTENT_CATEGORIES.map((c) => ({
    key: c.key,
    children: categoryChildren.get(c.key) || 0,
  }));

  return {
    children,
    devices,
    childrenWithRules,
    customDomains,
    allowances,
    categoryUsage,
  };
};

// GET /admin/content-filtering
const getContentFiltering = async (req, res, next) => {
  try {
    const policy = await getContentPolicy();
    const [attempts, cover] = await Promise.all([blockedAttempts(policy), coverage()]);

    res.json({
      policy,
      strength: policyStrength(policy),
      // Domains the policy resolves to right now — the number an operator needs
      // to judge what switching a category on actually does.
      enforcedDomains: (policy.categories || []).reduce((n, key) => n + domainsForCategory(key).length, 0)
        + (policy.domainRules || []).filter((r) => r.action === 'block').length,
      catalogue: categoryCatalogue(),
      windowDays: WINDOW_DAYS,
      summary: { ...cover, blockedAttempts: attempts },
    });
  } catch (err) {
    next(err);
  }
};

// PUT /admin/content-filtering
//
// The whole policy, every time. A patch of one category would need the client to
// know the rest of the document, and two operators editing at once would then
// silently drop each other's changes.
const updateContentFiltering = async (req, res, next) => {
  try {
    const { categories, domainRules } = req.body || {};

    if (categories !== undefined && !Array.isArray(categories)) {
      return res.status(400).json({ error: 'categories must be an array' });
    }
    if (domainRules !== undefined && !Array.isArray(domainRules)) {
      return res.status(400).json({ error: 'domainRules must be an array' });
    }

    const unknown = (categories || []).filter((key) => !CATEGORY_KEYS.includes(key));
    if (unknown.length) {
      return res.status(400).json({ error: `Unknown category: ${unknown.join(', ')}` });
    }
    if ((domainRules || []).length > MAX_DOMAIN_RULES) {
      return res.status(400).json({ error: `At most ${MAX_DOMAIN_RULES} domain rules` });
    }

    // A domain that cannot be enforced must not be stored: the device matches
    // DNS names, so `https://example.com/path` would be a rule that blocks
    // nothing while looking to the operator like one that does.
    const rejected = (domainRules || []).filter((r) => !normalizeDomain(r?.domain));
    if (rejected.length) {
      return res.status(400).json({
        error: `Enter a website domain, for example example.com — could not use: ${rejected.map((r) => r?.domain).join(', ')}`,
      });
    }

    const current = await getContentPolicy();

    // Who added a domain is stamped here, never taken from the request: a rule
    // that survived this edit keeps the operator already on it, and a new one is
    // attributed to whoever is signed in. A client-supplied name would be a
    // signature anyone could forge.
    const previous = new Map(current.domainRules.map((r) => [r.domain, r]));
    const stamped = (domainRules || []).map((rule) => {
      const domain = normalizeDomain(rule.domain);
      const existing = previous.get(domain);
      return existing && existing.action === (rule.action === 'allow' ? 'allow' : 'block')
        ? existing
        : { ...rule, domain, addedBy: req.user.name || req.user.email, addedAt: new Date().toISOString() };
    });

    const saved = await setContentPolicy({
      categories: categories === undefined ? current.categories : categories,
      domainRules: domainRules === undefined ? current.domainRules : stamped,
    });

    auditLog(req, {
      userId: req.user.id,
      action: 'admin.content_filtering_updated',
      entity: 'SystemSetting',
      metadata: {
        categories: saved.categories,
        domainRules: saved.domainRules.length,
        strength: policyStrength(saved),
      },
    });

    res.json({ policy: saved, strength: policyStrength(saved) });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getContentFiltering,
  updateContentFiltering,
  // Exported for the tests, which assert the aggregate rather than the route.
  blockedAttempts,
  normalizePolicy,
  MAX_DOMAIN_RULES,
};
