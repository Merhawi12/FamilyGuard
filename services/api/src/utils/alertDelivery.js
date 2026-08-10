/**
 * Which alert types are held back from email and push, platform-wide.
 *
 * One alert type can flood every parent at once — a device that trips
 * `blocked_app_attempt` in a loop, a detector that starts matching too eagerly —
 * and the only lever the platform had for it was asking parents to switch it off
 * one at a time. This is the operator's kill switch, set on the console's
 * Overview screen.
 *
 * It suppresses **delivery**, never the alert. The record is still written and
 * still broadcast to the parent's open dashboard, so nothing about a child's
 * safety is hidden by it — what stops is the email and the push. On a
 * child-safety platform that distinction is the whole design: muting must cost a
 * parent a notification, not the fact.
 */
const { getSetting, setSetting } = require('./settings');
const { ALERT_TYPE_KEYS } = require('../config/alertTypes');

const SETTING_KEY = 'mutedAlertTypes';

const getMutedAlertTypes = async () => {
  const stored = await getSetting(SETTING_KEY, []);
  return Array.isArray(stored) ? stored.filter((key) => ALERT_TYPE_KEYS.includes(key)) : [];
};

const setMutedAlertTypes = async (keys) => {
  const clean = [...new Set((Array.isArray(keys) ? keys : []).filter((key) => ALERT_TYPE_KEYS.includes(key)))];
  await setSetting(SETTING_KEY, clean);
  return clean;
};

module.exports = { SETTING_KEY, getMutedAlertTypes, setMutedAlertTypes };
