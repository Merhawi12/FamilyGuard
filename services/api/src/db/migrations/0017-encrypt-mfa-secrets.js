/**
 * The two credentials this database was still holding in the clear.
 *
 *   users.mfa_secret          the TOTP seed, converted in place to AES-256-GCM
 *                             ciphertext (see utils/crypto).
 *   users.password_reset_token the reset ticket, destroyed rather than converted.
 *
 * **Why the seed is converted and the ticket is not.** A TOTP seed is permanent:
 * it is the account's second factor for as long as MFA stays on, and rewriting
 * it would sign every one of those accounts out of their authenticator app with
 * no way back except a support conversation. It has to be carried across. A
 * reset ticket lives fifteen minutes, every one outstanding when a deploy starts
 * has effectively expired by the time it finishes, and the code that reads them
 * now looks up a digest — so a converted ticket would buy the holder nothing
 * that "ask for a new code" does not. Clearing is both simpler and stricter, and
 * it is what migration 0014 did with the codes for the same reasons.
 *
 * **Idempotent by shape.** A converted seed contains `:` (the iv:tag:ciphertext
 * form) and a base32 seed never can, so a re-run — a resumed deploy, a migration
 * table restored from a different environment — skips what it already did rather
 * than encrypting ciphertext, which would destroy the seed irrecoverably.
 *
 * **This one needs FIELD_ENCRYPTION_KEY.** Every deployed environment has it
 * (`assertProductionConfig` refuses to boot without a 64-hex value), and a
 * deployment that somehow does not is one where nothing else encrypted works
 * either — so it fails loudly here rather than storing a seed it cannot open.
 * Rows are read and written one at a time because the encryption happens in
 * this process, not in SQL.
 */
const { encrypt } = require('../../utils/crypto');
const logger = require('../../utils/logger');

/** Already-encrypted values carry the `iv:tag:ciphertext` separator; seeds cannot. */
const isEncrypted = (value) => typeof value === 'string' && value.includes(':');

module.exports = {
  async up(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      "SELECT id, mfa_secret FROM users WHERE mfa_secret IS NOT NULL AND mfa_secret <> ''"
    );

    let converted = 0;
    for (const row of rows) {
      if (isEncrypted(row.mfa_secret)) continue;
      await queryInterface.sequelize.query(
        'UPDATE users SET mfa_secret = :secret WHERE id = :id',
        { replacements: { secret: encrypt(row.mfa_secret), id: row.id } }
      );
      converted += 1;
    }

    if (converted) logger.info('[migration] encrypted MFA secrets at rest', { converted });

    /**
     * Tickets in flight go, exactly as the codes did in 0014. `reset-password`
     * matches on a digest from here, so a plaintext ticket left in the column
     * could never be redeemed anyway — clearing it is what stops it sitting in
     * the next backup as a live-looking key.
     */
    await queryInterface.sequelize.query(
      'UPDATE users SET password_reset_token = NULL, password_reset_expires = NULL'
    );
  },

  /**
   * Deliberately empty.
   *
   * Rolling back would mean writing every TOTP seed back into the database in
   * plain text, which is the defect this migration exists to remove — a `down`
   * that restores a vulnerability is not a rollback, it is a second incident.
   * The application reads both shapes (`decrypt` passes a value with no `:`
   * through untouched), so an older build of the API runs against this schema
   * for everything except MFA validation, and the way back from that is to roll
   * the code forward rather than the data back.
   */
  async down() {},
};
