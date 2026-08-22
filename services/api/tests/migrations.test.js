const { sequelize } = require('../src/config/db');
const { migrator } = require('../src/db/migrator');
const { initializeDatabase } = require('../src/db');
const { User } = require('../src/models');
const { getSetting, setSetting } = require('../src/utils/settings');
const { createUser } = require('./helpers');

/**
 * The suite's schema comes from `sync({ force: true })`, so these check that the
 * migration layer is wired correctly and safe to run on top of it — which is
 * exactly what happens when a Cloud Run instance boots against an existing database.
 */

/**
 * Jest's default is five seconds, and it is not enough for this file on Postgres.
 *
 * `initializeDatabase()` takes a lock and runs the whole migration list, and on
 * SQLite — an in-process file — that is fast enough to hide the problem. Against
 * a real server every `ALTER TABLE` is a round trip, so the first test lands
 * within a few hundred milliseconds of the limit and tips over it on a busy
 * machine. When it does, the timeout leaves the migration table half-written and
 * the *second* test then fails too, on a duplicate-key insert that looks like a
 * genuine idempotency bug and is not.
 *
 * That makes `npm run test:pg` — the gate that exists precisely because a green
 * SQLite run says nothing about Cloud SQL — fail for a reason that has nothing
 * to do with the code under test. The number is deliberately generous: nothing
 * here is asserting speed.
 */
jest.setTimeout(60000);

describe('database migrations', () => {
  it('applies every migration and leaves none pending', async () => {
    await initializeDatabase();

    const pending = await migrator.pending();
    expect(pending).toHaveLength(0);

    const executed = await migrator.executed();
    expect(executed.map((m) => m.name)).toEqual(
      expect.arrayContaining([
        '0001-user-account-columns.js',
        '0002-hot-path-indexes.js',
        '0003-child-avatar-url.js',
        '0004-super-admin-role.js',
        '0005-reset-passwords-permission.js',
      ])
    );
  });

  it('is idempotent — a second boot applies nothing and does not throw', async () => {
    await initializeDatabase();
    const before = (await migrator.executed()).length;

    await initializeDatabase();
    const after = (await migrator.executed()).length;

    expect(after).toBe(before);
  });

  it('produces the columns the models expect', async () => {
    await initializeDatabase();

    const users = await sequelize.getQueryInterface().describeTable('users');
    expect(users).toHaveProperty('password_reset_token');
    expect(users).toHaveProperty('failed_login_attempts');

    const children = await sequelize.getQueryInterface().describeTable('children');
    expect(children).toHaveProperty('avatar_url');
  });

  /**
   * Boots against a database that predates a migration, which is the only
   * arrangement in which a whole class of failure shows up.
   *
   * Every other test here starts from `sync({ force: true })`, so each table is
   * created with the current columns already present and `sync()` can build any
   * index a model declares. A deployed database is nothing like that: the table
   * already exists, `sync()` will not add a column to it, and an index declared
   * on a model over a column a migration has not added yet fails outright —
   * before the migrations that would have fixed it ever run. The API then never
   * finishes booting, and no fresh-database test can see it.
   */
  it('boots against a database created before the newest migrations ran', async () => {
    await initializeDatabase();
    const qi = sequelize.getQueryInterface();

    // Wind activity_logs back to its pre-0007 shape and mark the migration
    // unapplied, so this boot faces exactly what a deploy faces.
    await qi.removeIndex('activity_logs', 'activity_logs_child_id_url_hash_start_time').catch(() => {});
    await qi.removeColumn('activity_logs', 'url_hash');
    await qi.removeColumn('activity_logs', 'visit_count');
    await sequelize.query("DELETE FROM migrations WHERE name = '0007-web-history.js'");

    const before = await qi.describeTable('activity_logs');
    expect(before).not.toHaveProperty('url_hash');

    await expect(initializeDatabase()).resolves.not.toThrow();

    const after = await qi.describeTable('activity_logs');
    expect(after).toHaveProperty('url_hash');
    expect(after).toHaveProperty('visit_count');
  });

  /**
   * The same test for 0016, and it is here because its absence cost a failed
   * production deploy.
   *
   * `sync()` runs before the migrations and tries to create every index the
   * models declare, but it will not add a column to a table that already
   * exists. Declaring the `device_id` index on the three rule models therefore
   * worked on every fresh database — which is every test database — and failed
   * on the only kind that matters: `column "device_id" does not exist`, the
   * container exiting 1, and the revision never serving.
   *
   * The index belongs to the migration alone. This test is what says so in a
   * way that runs.
   */
  it('boots against a database that predates the per-device columns', async () => {
    await initializeDatabase();
    const qi = sequelize.getQueryInterface();
    const RULE_TABLES = ['app_rules', 'website_rules', 'screen_time_rules'];

    for (const table of RULE_TABLES) {
      await qi.removeIndex(table, `${table}_device_id`).catch(() => {});
      await qi.removeColumn(table, 'device_id');
    }
    await qi.removeColumn('devices', 'blocked_at');
    await sequelize.query("DELETE FROM migrations WHERE name = '0016-per-device-controls.js'");

    for (const table of RULE_TABLES) {
      expect(await qi.describeTable(table)).not.toHaveProperty('device_id');
    }

    // The whole assertion: a boot that faces what a deploy faces must not throw.
    await expect(initializeDatabase()).resolves.not.toThrow();

    for (const table of RULE_TABLES) {
      expect(await qi.describeTable(table)).toHaveProperty('device_id');
    }
    expect(await qi.describeTable('devices')).toHaveProperty('blocked_at');
  });

  /**
   * 0009 retires the `family` tier. Getting this wrong is not cosmetic: an
   * account left on `family` looks up an entitlement list that no longer exists,
   * resolves to `[]`, and loses GPS, geofencing, filtering and AI safety while
   * still being billed $14.99.
   */
  describe('0009 folds Family Plus into Premium', () => {
    const migration = require('../src/db/migrations/0009-fold-family-plan-into-premium');

    it('moves family accounts to premium and leaves the others alone', async () => {
      await initializeDatabase();
      const legacy = await createUser({ plan: 'family' });
      const paid = await createUser({ plan: 'premium' });
      const gratis = await createUser({ plan: 'free' });

      await migration.up(sequelize.getQueryInterface());

      expect((await User.findByPk(legacy.id)).plan).toBe('premium');
      expect((await User.findByPk(paid.id)).plan).toBe('premium');
      expect((await User.findByPk(gratis.id)).plan).toBe('free');
    });

    it('strips family from a customised planFeatures setting, keeping its features on premium', async () => {
      await initializeDatabase();
      await setSetting('planFeatures', {
        free: [],
        premium: ['gps_tracking'],
        family: ['gps_tracking', 'ai_safety'],
      });

      await migration.up(sequelize.getQueryInterface());

      const saved = await getSetting('planFeatures');
      expect(saved).not.toHaveProperty('family');
      // An operator who had customised the matrix must not find AI safety
      // silently switched off for the people who were paying for it.
      expect([...saved.premium].sort()).toEqual(['ai_safety', 'gps_tracking']);
    });

    it('is safe to run twice', async () => {
      await initializeDatabase();
      await setSetting('planFeatures', { free: [], premium: ['gps_tracking'] });

      await migration.up(sequelize.getQueryInterface());
      await expect(migration.up(sequelize.getQueryInterface())).resolves.not.toThrow();

      expect(await getSetting('planFeatures')).toEqual({ free: [], premium: ['gps_tracking'] });
    });
  });

  /**
   * 0017 is the only migration here that rewrites a live credential in place,
   * which makes both directions of getting it wrong expensive.
   *
   * Skip a row and the seed stays readable in the next backup — the whole point
   * of the migration. Encrypt a row twice and the seed is gone for good, with
   * MFA the only way into an account whose codes now all fail. So the shape it
   * keys on (a base32 seed can never contain `:`) is what these tests hold.
   */
  describe('0017 encrypts MFA secrets in place', () => {
    const migration = require('../src/db/migrations/0017-encrypt-mfa-secrets');
    const { decrypt, encrypt } = require('../src/utils/crypto');

    /** The stored bytes, with every model hook bypassed. */
    const rawSecret = async (id) => {
      const [rows] = await sequelize.query(
        'SELECT mfa_secret AS value FROM users WHERE id = :id',
        { replacements: { id } },
      );
      return rows[0]?.value ?? null;
    };

    it('converts a seed an older build left in plain base32', async () => {
      await initializeDatabase();
      const user = await createUser({ mfaEnabled: true });
      await sequelize.query('UPDATE users SET mfa_secret = :s WHERE id = :id', {
        replacements: { s: 'JBSWY3DPEHPK3PXP', id: user.id },
      });

      await migration.up(sequelize.getQueryInterface());

      const stored = await rawSecret(user.id);
      expect(stored).not.toBe('JBSWY3DPEHPK3PXP');
      expect(decrypt(stored)).toBe('JBSWY3DPEHPK3PXP');
      // And the account still works: the model reads it back as the seed.
      expect((await User.findByPk(user.id)).mfaSecret).toBe('JBSWY3DPEHPK3PXP');
    });

    it('leaves an already-encrypted seed exactly as it found it', async () => {
      await initializeDatabase();
      const user = await createUser({ mfaEnabled: true });
      const sealed = encrypt('JBSWY3DPEHPK3PXP');
      await sequelize.query('UPDATE users SET mfa_secret = :s WHERE id = :id', {
        replacements: { s: sealed, id: user.id },
      });

      await migration.up(sequelize.getQueryInterface());

      // Byte-identical, not merely still decryptable — a re-encrypt would also
      // decrypt cleanly *once* and then be unrecoverable.
      expect(await rawSecret(user.id)).toBe(sealed);
    });

    it('is safe to run twice', async () => {
      await initializeDatabase();
      const user = await createUser({ mfaEnabled: true });
      await sequelize.query('UPDATE users SET mfa_secret = :s WHERE id = :id', {
        replacements: { s: 'JBSWY3DPEHPK3PXP', id: user.id },
      });

      await migration.up(sequelize.getQueryInterface());
      await migration.up(sequelize.getQueryInterface());

      expect(decrypt(await rawSecret(user.id))).toBe('JBSWY3DPEHPK3PXP');
    });

    it('destroys reset tickets rather than converting them', async () => {
      await initializeDatabase();
      const user = await createUser();
      await sequelize.query(
        'UPDATE users SET password_reset_token = :t WHERE id = :id',
        { replacements: { t: 'a-plaintext-ticket', id: user.id } },
      );

      await migration.up(sequelize.getQueryInterface());

      // Fifteen-minute secrets: every one outstanding when a deploy starts has
      // effectively expired by the time it finishes, and `reset-password` looks
      // up a digest now, so a converted ticket would buy its holder nothing.
      expect((await User.findByPk(user.id)).passwordResetToken).toBeNull();
    });

    it('leaves accounts without MFA alone', async () => {
      await initializeDatabase();
      const user = await createUser();

      await expect(migration.up(sequelize.getQueryInterface())).resolves.not.toThrow();
      expect(await rawSecret(user.id)).toBeNull();
    });
  });
});
