const { Op } = require('sequelize');

/**
 * The severity and the origin of an audit entry.
 *
 * The console's System Logs screen shows every entry with a level and a service,
 * and neither of them is a column. An audit action is written as `service.event`
 * — `auth.login_failed`, `admin.user_deleted` — and that name is the whole of
 * what the platform records about how serious the entry is, so both are derived
 * from it.
 *
 * They are derived here rather than in the screen because the level is a filter.
 * Classifying in the browser would narrow the fifty rows on the page while the
 * count, the paginator and "Showing 1–50 of 12,480" all went on describing the
 * unfiltered set — an operator looking for this hour's errors would page through
 * mostly empty screens. One rule set, used both to label a row and to build the
 * query, is what keeps those two answers the same.
 *
 * The rule behind the mapping is how much of it you would want to be woken for:
 *
 *   critical  irreversible, or somebody is locked out of their account
 *   error     a request the platform refused
 *   warning   a change worth being able to point at afterwards
 *   info      the ordinary record
 *
 * The suffixes cover the actions that do not exist yet: an action added next
 * month ending in `_failed` is an error without anyone remembering to list it,
 * and because the query is built from the same rules, the level filter finds it
 * too.
 */

// Most severe first — an action matching two rules takes the first of them,
// which is why `admin.user_deleted` is critical rather than a `_deleted` warning.
const LEVEL_RULES = [
  {
    level: 'critical',
    actions: ['admin.user_deleted', 'staff.deleted', 'auth.login_blocked_locked'],
    suffixes: [],
  },
  {
    level: 'error',
    actions: ['auth.login_failed', 'auth.mfa_failed', 'auth.login_blocked_inactive'],
    suffixes: ['_failed', '_blocked'],
  },
  {
    level: 'warning',
    actions: [
      'admin.role_changed', 'admin.plan_changed', 'admin.session_revoked',
      'admin.settings_updated', 'admin.user_logged_out_everywhere', 'admin.user_password_reset',
      'auth.mfa_disabled', 'auth.password_reset', 'auth.password_reset_requested',
      'staff.created', 'staff.password_reset',
    ],
    suffixes: ['_deleted', '_removed', '_revoked'],
  },
];

/** Every level, most severe first. `info` is what is left over, so it has no rule. */
const LEVELS = [...LEVEL_RULES.map((rule) => rule.level), 'info'];

/**
 * The services that write audit entries, in the order the console offers them.
 *
 * A prefix that is not on this list still classifies and still lists — the list
 * is what the filter row offers, not what the reader accepts.
 */
const SERVICES = ['auth', 'admin', 'device', 'staff', 'safezone', 'upload'];

/**
 * A suffix as a pattern, read the way SQL reads it.
 *
 * `_` is a single-character wildcard in LIKE, so `%_failed` also matches
 * `logfailed`. That is harmless — no action is named that way — but the label
 * and the filter have to agree about it, or a row could show as an error that
 * the error filter then cannot find. Matching in JavaScript with the same
 * wildcard is cheaper than escaping it in two dialects.
 */
const suffixPattern = (suffix) => new RegExp(`${suffix.replace(/_/g, '.')}$`);

const ruleMatches = (rule, action) => rule.actions.includes(action)
  || rule.suffixes.some((suffix) => suffixPattern(suffix).test(action));

/** The level of one action. Anything unclaimed is ordinary. */
const levelFor = (action) => (LEVEL_RULES.find((rule) => ruleMatches(rule, action || ''))?.level) || 'info';

/** The service that wrote the entry — the part of the action before the dot. */
const serviceFor = (action) => {
  const dot = String(action || '').indexOf('.');
  return dot > 0 ? action.slice(0, dot) : 'platform';
};

/** Every way a rule can match, OR-ed together. */
const matching = (rule) => [
  ...(rule.actions.length ? [{ action: { [Op.in]: rule.actions } }] : []),
  ...rule.suffixes.map((suffix) => ({ action: { [Op.like]: `%${suffix}` } })),
];

/**
 * The same rule negated — De Morgan rather than `Op.not` around a group, which
 * both dialects then have to agree how to nest. An empty `NOT IN ()` is skipped
 * because SQL evaluates it to NULL, which would quietly match nothing at all.
 */
const excluding = (rule) => [
  ...(rule.actions.length ? [{ action: { [Op.notIn]: rule.actions } }] : []),
  ...rule.suffixes.map((suffix) => ({ action: { [Op.notLike]: `%${suffix}` } })),
];

/**
 * A `where` fragment selecting exactly the entries `levelFor` calls `level`.
 *
 * Every rule above the requested one is negated as well, so asking for warnings
 * does not also return the deletions that count as critical.
 */
const levelCondition = (level) => {
  const index = LEVEL_RULES.findIndex((rule) => rule.level === level);
  if (index === -1) return { [Op.and]: LEVEL_RULES.flatMap(excluding) }; // info
  return {
    [Op.and]: [
      { [Op.or]: matching(LEVEL_RULES[index]) },
      ...LEVEL_RULES.slice(0, index).flatMap(excluding),
    ],
  };
};

module.exports = { LEVELS, SERVICES, levelFor, serviceFor, levelCondition };
