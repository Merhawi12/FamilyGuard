// Creates a fresh in-memory schema before each test file and tears it down after.
const { sequelize } = require('../src/config/db');
const { clearSettingsCache } = require('../src/utils/settings');
require('../src/models'); // define models + associations

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

/**
 * The system-settings cache does not survive into the next test.
 *
 * `utils/settings.js` holds values for thirty seconds so the device-sync and
 * sign-in paths do not re-read them per request. That cache is module state, and
 * a Jest worker reuses the module across every file it runs — so without this a
 * policy cached by one test would be served to the next, and to the next *file*,
 * whose database is a different one entirely.
 *
 * It also covers the suites that clear settings with `SystemSetting.destroy`
 * rather than `setSetting`, which is the write path that invalidates. Those are
 * doing the right thing for a test; this is what keeps it true.
 */
beforeEach(() => {
  clearSettingsCache();
});

afterAll(async () => {
  await sequelize.close();
});
