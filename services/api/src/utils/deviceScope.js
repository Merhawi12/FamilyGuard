const { Op } = require('sequelize');

/**
 * How a rule that names one device relates to the child-wide rule beside it.
 *
 * Every rule row carries a nullable `deviceId`. NULL means "every device this
 * child owns", which is what all rules meant before per-device control existed
 * and is still what the dashboard writes unless the parent narrows it. A row
 * naming a device applies to that device *instead of* the child-wide row it
 * collides with.
 *
 * Override, not union, and the distinction is the whole design. A union cannot
 * express the request that motivated this — "the school laptop gets three hours,
 * everything else gets one" — because the child-wide hour would still apply and
 * the laptop would lock at the same moment. With an override the parent's
 * general rule stays the general rule and the exception is visibly an exception,
 * which is also how they described it.
 *
 * What "collides" means differs per rule type, and getting it wrong is silent in
 * both directions — too broad and an exception leaks onto a sibling, too narrow
 * and the exception is ignored while the UI shows it as set. So each rule type
 * names its identity here, once, and both the device sync and the parent's own
 * listing go through the same function.
 *
 * The resolution happens on the server, inside the sync the device already
 * makes. A phone is handed the rules that apply to it and never learns that a
 * rule for its sibling exists.
 */

/**
 * The `where` clause for "rules this device must obey": the child's general
 * rules plus this device's own, and nothing belonging to a sibling.
 *
 * `deviceId` is deliberately required. Calling this with `undefined` would build
 * `deviceId: undefined`, which Sequelize drops from the clause — quietly turning
 * a device-scoped read into a read of every rule the family has, including its
 * siblings'. That is exactly the leak this module exists to prevent.
 */
const rulesVisibleTo = (childId, deviceId) => {
  if (!deviceId) throw new Error('rulesVisibleTo requires a deviceId — pass the device, not undefined');
  return { childId, [Op.or]: [{ deviceId: null }, { deviceId }] };
};

/** An app rule is identified by the package the phone actually matches on. */
const appKey = (rule) => String(rule.appPackage || '').trim().toLowerCase();

/**
 * A website rule is identified by its domain, or by its category when it has no
 * domain. `contentPolicy` expands a category into domains later; two rules that
 * expand to the same list must still be one rule here, or a device-specific
 * "allow youtube.com" would sit alongside the child-wide "block youtube.com"
 * rather than replacing it, and which one won would depend on array order.
 */
const websiteKey = (rule) => {
  const url = String(rule.url || '').trim().toLowerCase();
  return url || `category:${String(rule.category || '').trim().toLowerCase()}`;
};

/**
 * Collapse a mixed list of child-wide and device-specific rows into the set that
 * applies to one device.
 *
 * Order-independent on purpose: the caller is a `findAll` with no ORDER BY, and
 * a resolution that depended on which row the database returned first would work
 * on every machine it was tried on and then not on production.
 */
const resolveScoped = (rows, keyOf) => {
  const byKey = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const existing = byKey.get(key);
    // A device-specific row beats a child-wide one. Two rows at the same scope
    // are two genuinely different rules only when their keys differ, so the
    // first is kept and this cannot drop a rule the parent can see.
    if (!existing || (row.deviceId && !existing.deviceId)) byKey.set(key, row);
  }
  return [...byKey.values()];
};

const resolveAppRules = (rows) => resolveScoped(rows, appKey);
const resolveWebsiteRules = (rows) => resolveScoped(rows, websiteKey);

/**
 * Screen time overrides as a whole rule, not field by field.
 *
 * A per-field merge reads as the kinder choice and is the wrong one: a parent
 * setting a three-hour limit on the laptop has not said anything about its
 * bedtime, and inheriting the tablet's 21:00 would lock the laptop mid-essay
 * with no control anywhere showing why. A device rule is created as a copy of
 * the child's (see screenTimeController), so it starts out saying the same thing
 * and every field the parent then changes is one they looked at.
 */
const resolveScreenTimeRule = (rows) =>
  rows.find((r) => r.deviceId) || rows.find((r) => !r.deviceId) || null;

/**
 * Extra minutes, which **add up instead of overriding** — the one exception to
 * everything above, and the reason it is written here rather than left implicit
 * at the call site.
 *
 * A rule is a statement about how things are, so a device-specific one and a
 * child-wide one are two answers to the same question and the narrower has to
 * win. A grant is not a statement; it is a parent saying yes to one request. Two
 * yeses are more minutes, whichever scope each was given at — a parent who adds
 * fifteen minutes to the whole child and then fifteen more to the laptop the
 * child is actually working on has plainly given that laptop thirty, and an
 * override would silently discard half of what they did.
 *
 * The rows are handed on with their timestamps rather than summed here, because
 * only the device knows which of them still count: a grant is spent against the
 * child's usage day, and that day opens at the *device's* local midnight. See
 * models/ScreenTimeGrant.js.
 */
const resolveScreenTimeGrants = (rows) =>
  rows
    .map((row) => ({
      minutes: Number(row.minutes) || 0,
      grantedAt: new Date(row.createdAt).toISOString(),
    }))
    .filter((grant) => grant.minutes > 0);

module.exports = {
  rulesVisibleTo,
  resolveAppRules,
  resolveWebsiteRules,
  resolveScreenTimeRule,
  resolveScreenTimeGrants,
  appKey,
  websiteKey,
};
