const { fn, col } = require('sequelize');
const { AppRule, WebsiteRule, Child, Device, ActivityLog } = require('../models');
const { normalizeDomain } = require('../utils/domain');
const { isUuid } = require('../utils/ids');

// A malformed id is "not found", not a database error — see utils/ids.js for why
// this has to be checked before the query rather than after it.
const verifyChild = async (parentId, childId) =>
  (isUuid(childId) ? Child.findOne({ where: { id: childId, parentId } }) : null);

/** The same guard for a rule id, which is a UUID on both rule tables. */
const findRule = (Model, ruleId, childId) =>
  (isUuid(ruleId) ? Model.findOne({ where: { id: ruleId, childId } }) : null);

/**
 * Resolve the optional `deviceId` a rule may be narrowed to.
 *
 * Returns `{ deviceId }` on success — `null` for a child-wide rule, which is
 * both the default and what every rule was before per-device control — or
 * `{ error }` when the id is not a live device of *this* child.
 *
 * That ownership check is the whole reason this is a function. `deviceId`
 * arrives in the request body, and a rule written against another family's
 * device id would be a parent silently writing policy onto a stranger's phone.
 * The child is already proved to belong to the caller by the time this runs, so
 * matching the device to the child is enough to close it.
 */
const resolveDeviceScope = async (childId, raw) => {
  if (raw === undefined || raw === null || raw === '') return { deviceId: null };
  if (!isUuid(raw)) return { error: 'Unknown device' };
  const device = await Device.findOne({ where: { id: raw, childId, isActive: true } });
  if (!device) return { error: 'Unknown device' };
  return { deviceId: device.id };
};

/**
 * Tell the devices a rule change actually reaches.
 *
 * A child-wide rule goes to the child's room, as it always has. A rule narrowed
 * to one device goes only to that device — waking its siblings to re-sync rules
 * that did not move is wasted radio on a phone, and the resulting `rules_updated`
 * would be indistinguishable to them from a real change.
 */
const announceRuleChange = (req, childId, deviceId, type) => {
  const io = req.app.get('io');
  if (!io) return;
  io.to(deviceId ? `device:${deviceId}` : `child:${childId}`).emit('rules_updated', { type });
};

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
 * read them. `limit` was made real first — the column it needs was already on
 * this model — and `allow` was removed outright, on the grounds that whitelisting
 * apps means blocking every *other* app on the phone including the dialer, and
 * the device had no way to express an exception.
 *
 * It is back, and it means something narrower and safer than it did. An `allow`
 * rule does not whitelist the phone: it names an app that stays open **when the
 * daily limit runs out**, which is the one lock a parent routinely wants to be
 * porous. Homework does not stop because the entertainment budget is spent.
 *
 * Three things bound it, and all three are enforced on the device rather than
 * here, because that is where a lock is applied:
 *
 *  - it applies to the `daily_limit` lock only. Bedtime, an out-of-hours
 *    schedule and a parent's own pause are strict — those exist to stop use, not
 *    to ration it, and an allowlist would quietly gut all three.
 *  - it never overrides a `block` rule. "Blocked" outranks "allowed" whichever
 *    order the rows arrive in.
 *  - it is not the safety exception. The dialer, messaging, contacts and the
 *    clock are never blocked by anything, with or without a rule — that lives in
 *    the accessibility service itself so it survives the app being killed. See
 *    AppMonitorService.kt.
 */
const APP_ACTIONS = new Set(['block', 'limit', 'allow']);

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
    return res.status(400).json({
      error: 'An app rule can block the app, limit its daily use, or keep it open once the daily limit is reached.',
    });
  }

  let dailyLimitMinutes = null;
  if (action === 'limit') {
    dailyLimitMinutes = Number(req.body.dailyLimitMinutes);
    if (!Number.isInteger(dailyLimitMinutes) || dailyLimitMinutes < 5 || dailyLimitMinutes > 1440) {
      return res.status(400).json({ error: 'Set a daily limit between 5 and 1440 minutes.' });
    }
  }

  const scope = await resolveDeviceScope(req.params.childId, req.body.deviceId);
  if (scope.error) return res.status(400).json({ error: scope.error });

  // Field by field rather than a spread of the body: `childId` is the caller's
  // to supply and `id` is not, and neither belongs to whatever JSON arrives.
  const rule = await AppRule.create({
    childId: req.params.childId,
    deviceId: scope.deviceId,
    appName,
    appPackage,
    action,
    dailyLimitMinutes,
    category: req.body.category ? String(req.body.category) : null,
  });

  announceRuleChange(req, req.params.childId, scope.deviceId, 'app');
  return res.status(201).json(rule);
};

const removeAppRule = async (req, res) => {
  if (!(await verifyChild(req.user.id, req.params.childId))) return res.status(404).json({ error: 'Child not found' });
  const rule = await findRule(AppRule, req.params.ruleId, req.params.childId);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  const { deviceId } = rule;
  await rule.destroy();
  announceRuleChange(req, req.params.childId, deviceId, 'app');
  return res.json({ message: 'Rule removed' });
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

  const scope = await resolveDeviceScope(req.params.childId, req.body.deviceId);
  if (scope.error) return res.status(400).json({ error: scope.error });

  // Field by field, for the same reason as the app rule above.
  const rule = await WebsiteRule.create({
    childId: req.params.childId,
    deviceId: scope.deviceId,
    url,
    category,
    action,
  });
  announceRuleChange(req, req.params.childId, scope.deviceId, 'website');
  return res.status(201).json(rule);
};

const removeWebsiteRule = async (req, res) => {
  if (!(await verifyChild(req.user.id, req.params.childId))) return res.status(404).json({ error: 'Child not found' });
  const rule = await findRule(WebsiteRule, req.params.ruleId, req.params.childId);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  const { deviceId } = rule;
  await rule.destroy();
  announceRuleChange(req, req.params.childId, deviceId, 'website');
  return res.json({ message: 'Rule removed' });
};

module.exports = {
  getAppRules, listKnownApps, addAppRule, removeAppRule,
  getWebsiteRules, addWebsiteRule, removeWebsiteRule,
};
