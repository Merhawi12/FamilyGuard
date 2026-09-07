const { SystemSetting } = require('../models');

/**
 * The `system_settings` table, with a short-lived cache in front of it.
 *
 * ── Why a cache, for five rows ───────────────────────────────────────────────
 *
 * Because of where they are read, not how many there are. Every one of these is
 * consulted on a hot path:
 *
 *   - `contentFiltering` on **every device rules sync** — the highest-rate
 *     authenticated call on the platform, once per five minutes per linked
 *     device, for ever.
 *   - `maintenanceMode` and `defaultTrialDays` on **every sign-in**.
 *   - `planFeatures` on **every feature-gated request**.
 *   - `alertDelivery` on **every alert raised**.
 *
 * They are written from one console screen, by a handful of staff, perhaps
 * monthly. So the read side was paying a database round trip per request to
 * learn something that had not changed since the last deploy.
 *
 * ── Why it is safe ───────────────────────────────────────────────────────────
 *
 * Two mechanisms, and the second is the one that matters:
 *
 *   1. `setSetting` drops the entry, so the instance that took the write is
 *      correct immediately. That covers the operator watching the screen they
 *      just changed.
 *   2. Every entry expires after `TTL_MS` regardless. The API runs as several
 *      Cloud Run instances and a write to one invalidates nothing on the others,
 *      so this — not the invalidation — is what bounds how stale any instance can
 *      be. Thirty seconds is chosen against the slowest consumer that matters: a
 *      device already polls content filtering every five minutes, so the cache
 *      cannot meaningfully delay a policy change, and an operator taking the
 *      platform down for a migration is not counting seconds.
 *
 * A read that throws is not cached, so a brief database problem cannot pin a
 * wrong answer in memory for the next half minute — which for `maintenanceMode`
 * would be a platform-wide lockout. See utils/maintenance.js.
 */

/** How long a value may be served without re-reading it. */
const TTL_MS = 30 * 1000;

/** key → { value, expires } */
const cache = new Map();

const getSetting = async (key, fallback = null) => {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value === undefined ? fallback : hit.value;

  const row = await SystemSetting.findByPk(key);
  // The row's absence is cached too: a platform that has never set a policy asks
  // for it on every sync, and "no row" is as valid an answer as a row.
  const value = row ? row.value : undefined;
  cache.set(key, { value, expires: Date.now() + TTL_MS });
  return value === undefined ? fallback : value;
};

const setSetting = async (key, value) => {
  await SystemSetting.upsert({ key, value });
  // Dropped rather than written through: the upsert is the source of truth and
  // a column default or hook could make what was stored differ from what was
  // passed. The next read fetches it.
  cache.delete(key);
  return value;
};

/**
 * Empties the cache.
 *
 * For tests, which create and destroy a database between cases — a value cached
 * from one case would otherwise outlive the row it came from and be served to
 * the next. Called from tests/db.setup.js.
 */
const clearSettingsCache = () => cache.clear();

module.exports = { getSetting, setSetting, clearSettingsCache, SETTINGS_TTL_MS: TTL_MS };
