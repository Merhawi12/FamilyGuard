const { fn, col } = require('sequelize');
const { AppRule, WebsiteRule, Child, ActivityLog } = require('../models');
const { normalizeDomain } = require('../utils/domain');
const { isUuid } = require('../utils/ids');

// A malformed id is "not found", not a database error — see utils/ids.js for why
// this has to be checked before the query rather than after it.
const verifyChild = async (parentId, childId) =>
  (isUuid(childId) ? Child.findOne({ where: { id: childId, parentId } }) : null);

/** The same guard for a rule id, which is a UUID on both rule tables. */
const findRule = (Model, ruleId, childId) =>
  (isUuid(ruleId) ? Model.findOne({ where: { id: ruleId, childId } }) : null);

const getAppRules = async (req, res) => {
  if (!(await verifyChild(req.user.id, req.params.childId))) return res.status(404).json({ error: 'Child not found' });
  const rules = await AppRule.findAll({ where: { childId: req.params.childId } });
  res.json(rules);
};

/**
 * The apps this child's devices have actually reported using.
 *
 * A rule is enforced by package name — that is the only identifier the
 * accessibility service sees — but a package name is not something a parent
 * knows or can look up. The rule form used to accept a bare app name with the
 * package left blank, which produced a rule that appeared in "Active app rules"
 * with a red Block badge and did absolutely nothing on the phone.
 *
 * This is where the missing half comes from: the device already uploads
 * `appName` and `appPackage` with every usage sample, so the apps the child uses
 * can be offered as a list to choose from and the package filled in for them.
 */
const listKnownApps = async (req, res) => {
  if (!(await verifyChild(req.user.id, req.params.childId))) return res.status(404).json({ error: 'Child not found' });

  const rows = await ActivityLog.findAll({
    where: { childId: req.params.childId, category: 'app_usage' },
    attributes: [
      'appName',
      'appPackage',
      [fn('SUM', col('duration_minutes')), 'totalMinutes'],
    ],
    group: ['appName', 'appPackage'],
    // Ordered by the aggregate itself rather than by its alias: quoting rules for
    // an output name differ between SQLite and Postgres, and this query has to
    // run unchanged on both.
    order: [[fn('SUM', col('duration_minutes')), 'DESC']],
    limit: 100,
    raw: true,
  });

  res.json(
    rows
      .filter((r) => r.appPackage)
      .map((r) => ({
        appName: r.appName || r.appPackage,
        appPackage: r.appPackage,
        totalMinutes: Number(r.totalMinutes) || 0,
      }))
  );
};

/**
 * What an app rule is allowed to say.
 *
 * `allow` and `limit` were both offered by the parent app's dropdown and neither
 * existed anywhere else: no server-side meaning, and nothing on the device that
 * read them. A parent could set "Allow only" on an app and the phone would carry
 * on exactly as before. `limit` is now real — the column it needs was already on
 * this model — and `allow` is gone rather than left as a switch that does
 * nothing. Whitelisting apps is not the same feature as whitelisting websites:
 * it means blocking everything else on the phone, including the dialer, and the
 * device has no exception mechanism to express it.
 */
const APP_ACTIONS = new Set(['block', 'limit']);

const addAppRule = async (req, res) => {
  if (!(await verifyChild(req.user.id, req.params.childId))) return res.status(404).json({ error: 'Child not found' });

  const appName = String(req.body.appName || '').trim();
  const appPackage = String(req.body.appPackage || '').trim();
  const action = String(req.body.action || 'block').trim();

  if (!appName) return res.status(400).json({ error: 'Enter the name of the app.' });

  /**
   * Rejected rather than stored, because the phone matches on package name and
   * nothing else. A rule without one is not a weaker rule, it is no rule — and
   * the one place that difference showed was on the child's phone, where nobody
   * was looking.
   */
  if (!appPackage) {
    return res.status(400).json({
      error: 'A package name is required — pick the app from the list, or enter it manually (e.g. com.roblox.client).',
    });
  }

  if (!APP_ACTIONS.has(action)) {
    return res.status(400).json({ error: 'An app rule can either block the app or limit its daily use.' });
  }

  let dailyLimitMinutes = null;
  if (action === 'limit') {
    dailyLimitMinutes = Number(req.body.dailyLimitMinutes);
    if (!Number.isInteger(dailyLimitMinutes) || dailyLimitMinutes < 5 || dailyLimitMinutes > 1440) {
      return res.status(400).json({ error: 'Set a daily limit between 5 and 1440 minutes.' });
    }
  }

  // Field by field rather than a spread of the body: `childId` is the caller's
  // to supply and `id` is not, and neither belongs to whatever JSON arrives.
  const rule = await AppRule.create({
    childId: req.params.childId,
    appName,
    appPackage,
    action,
    dailyLimitMinutes,
    category: req.body.category ? String(req.body.category) : null,
  });

  req.app.get('io').to(`child:${req.params.childId}`).emit('rules_updated', { type: 'app' });
  res.status(201).json(rule);
};

const removeAppRule = async (req, res) => {
  if (!(await verifyChild(req.user.id, req.params.childId))) return res.status(404).json({ error: 'Child not found' });
  const rule = await findRule(AppRule, req.params.ruleId, req.params.childId);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  await rule.destroy();
  req.app.get('io').to(`child:${req.params.childId}`).emit('rules_updated', { type: 'app' });
  res.json({ message: 'Rule removed' });
};

const WEBSITE_ACTIONS = new Set(['block', 'allow']);

const getWebsiteRules = async (req, res) => {
  if (!(await verifyChild(req.user.id, req.params.childId))) return res.status(404).json({ error: 'Child not found' });
  const rules = await WebsiteRule.findAll({ where: { childId: req.params.childId } });
  res.json(rules);
};

const addWebsiteRule = async (req, res) => {
  if (!(await verifyChild(req.user.id, req.params.childId))) return res.status(404).json({ error: 'Child not found' });

  /**
   * The device enforces these by matching DNS queries, so a rule has to be a
   * bare hostname. Parents paste what the address bar shows, so normalise it
   * here and reject anything that could never match — silently storing
   * `https://youtube.com/feed` would look like it worked and block nothing.
   *
   * A category-only rule carries no url and is left alone.
   */
  let url = null;
  if (req.body.url != null && String(req.body.url).trim() !== '') {
    url = normalizeDomain(req.body.url);
    if (!url) {
      return res.status(400).json({ error: 'Enter a website domain, for example example.com' });
    }
  }

  const category = req.body.category ? String(req.body.category).trim() : null;
  if (!url && (!category || category === 'custom')) {
    return res.status(400).json({ error: 'Enter a website domain, or pick a category to block.' });
  }

  // Unlike an app rule, `allow` is real here: `utils/contentPolicy` folds it into
  // the domain lists the device is given, where it overrides a block.
  const action = String(req.body.action || 'block').trim();
  if (!WEBSITE_ACTIONS.has(action)) {
    return res.status(400).json({ error: 'A website rule can either block the site or allow it.' });
  }

  // Field by field, for the same reason as the app rule above.
  const rule = await WebsiteRule.create({
    childId: req.params.childId,
    url,
    category,
    action,
  });
  req.app.get('io').to(`child:${req.params.childId}`).emit('rules_updated', { type: 'website' });
  res.status(201).json(rule);
};

const removeWebsiteRule = async (req, res) => {
  if (!(await verifyChild(req.user.id, req.params.childId))) return res.status(404).json({ error: 'Child not found' });
  const rule = await findRule(WebsiteRule, req.params.ruleId, req.params.childId);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  await rule.destroy();
  req.app.get('io').to(`child:${req.params.childId}`).emit('rules_updated', { type: 'website' });
  res.json({ message: 'Rule removed' });
};

module.exports = {
  getAppRules, listKnownApps, addAppRule, removeAppRule,
  getWebsiteRules, addWebsiteRule, removeWebsiteRule,
};
