/**
 * Reading and writing the platform-wide content-filtering policy.
 *
 * It lives in the `system_settings` row `contentFiltering`, next to maintenance
 * mode and the plan entitlements, because it is the same kind of thing: one
 * value an operator sets that every account is then subject to. Kept in its own
 * module rather than in the settings controller because the device-rules
 * endpoint reads it on every sync and must not have to pull a controller in to
 * do so.
 *
 * The default is an empty policy — no categories, no domains. A platform that
 * started out blocking things nobody asked for would be a support incident, not
 * a safe default; strictness is a choice an operator makes on the console's
 * Content Filtering screen.
 */
const { getSetting, setSetting } = require('./settings');
const { normalizePolicy, EMPTY_POLICY } = require('./contentPolicy');

const SETTING_KEY = 'contentFiltering';

const getContentPolicy = async () => normalizePolicy(await getSetting(SETTING_KEY, EMPTY_POLICY));

const setContentPolicy = async (policy) => {
  const clean = normalizePolicy(policy);
  await setSetting(SETTING_KEY, clean);
  return clean;
};

/**
 * How strict the policy reads, for the badge on the console screen.
 *
 * Derived rather than stored: a stored label is a second source of truth that
 * drifts from the switches the moment one is flipped.
 */
const policyStrength = (policy) => {
  const categories = policy?.categories?.length || 0;
  const blocks = (policy?.domainRules || []).filter((r) => r.action === 'block').length;
  if (categories === 0 && blocks === 0) return 'off';
  if (categories >= 4) return 'strict';
  if (categories >= 2 || blocks > 0) return 'standard';
  return 'light';
};

module.exports = { SETTING_KEY, getContentPolicy, setContentPolicy, policyStrength };
