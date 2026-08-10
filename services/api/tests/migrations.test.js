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
});
