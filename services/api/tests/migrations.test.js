const { sequelize } = require('../src/config/db');
const { migrator } = require('../src/db/migrator');
const { initializeDatabase } = require('../src/db');

/**
 * The suite's schema comes from `sync({ force: true })`, so these check that the
 * migration layer is wired correctly and safe to run on top of it — which is
 * exactly what happens when a Fargate task boots against an existing database.
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
});
