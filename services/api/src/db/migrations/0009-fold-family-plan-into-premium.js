/**
 * Retires the `family` (Family Plus) tier.
 *
 * Two plans are sold now, and Premium absorbed every feature Family Plus had —
 * so an account left on `family` would look up an entitlement list that no
 * longer exists and resolve to `[]`, silently losing GPS, geofencing, filtering
 * and AI safety while still being billed $14.99. This moves those accounts to
 * `premium`, where they keep everything.
 *
 * Their Stripe subscription is deliberately untouched: cancelling or re-pricing
 * a live subscription is a billing decision, not a schema one, and proration
 * would surprise people. They stay on the legacy price until someone moves them
 * in the Stripe dashboard; `planForPrice` in routes/payments.js knows to map
 * that price to Premium.
 *
 * The admin-editable `planFeatures` setting is cleaned too. It is written from
 * the Settings screen as a whole object, so a stale `family` key would come
 * straight back into the API's entitlement table on the next save.
 */
const readJson = (raw, fallback) => {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      "UPDATE users SET plan = 'premium' WHERE plan = 'family'"
    );

    // Historical transactions keep saying `family`. That is a record of what was
    // actually sold and must not be rewritten — only live entitlements move.

    // `key` is the primary key on this table; there is no id column.
    const [rows] = await queryInterface.sequelize.query(
      "SELECT key, value FROM system_settings WHERE key = 'planFeatures'"
    );
    for (const row of rows) {
      const value = readJson(row.value, null);
      if (!value || typeof value !== 'object' || !('family' in value)) continue;

      const { family, ...rest } = value;
      // Anything Family Plus unlocked has to survive on Premium, or an operator
      // who had customised the matrix would find features quietly switched off.
      rest.premium = [...new Set([...(rest.premium || []), ...(Array.isArray(family) ? family : [])])];

      await queryInterface.sequelize.query(
        'UPDATE system_settings SET value = :value WHERE key = :key',
        { replacements: { value: JSON.stringify(rest), key: row.key } }
      );
    }
  },

  async down() {
    // Irreversible by design. Which accounts were on `family` is not recorded
    // anywhere after the fact, so a `down` could only guess — and guessing would
    // downgrade Premium customers who never had Family Plus.
  },
};
