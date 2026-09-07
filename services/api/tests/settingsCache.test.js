/**
 * The cache in front of `system_settings`.
 *
 * It exists because these rows are read on the platform's hottest paths — the
 * content policy on every device rules sync, maintenance mode and the trial
 * length on every sign-in — and written from one console screen about once a
 * month. What has to stay true is that caching them cannot make the platform
 * wrong in a way an operator would not expect, so this pins the three
 * properties the design rests on rather than the speed, which no test can
 * usefully assert.
 */
const { SystemSetting } = require('../src/models');
const {
  getSetting, setSetting, clearSettingsCache, SETTINGS_TTL_MS,
} = require('../src/utils/settings');

beforeEach(async () => {
  clearSettingsCache();
  await SystemSetting.destroy({ where: {} });
});

describe('system settings cache', () => {
  it('serves a stored value and then serves it again without the row', async () => {
    await setSetting('demoKey', { hello: 'world' });
    expect(await getSetting('demoKey')).toEqual({ hello: 'world' });

    // Deleted behind the cache's back — the point is that the next read does
    // not go to the database at all.
    await SystemSetting.destroy({ where: { key: 'demoKey' } });
    expect(await getSetting('demoKey')).toEqual({ hello: 'world' });
  });

  /**
   * The invalidation that covers the operator watching the screen they just
   * changed: a write through `setSetting` must be visible on the next read from
   * the same instance, with no wait.
   */
  it('shows a write immediately on the instance that took it', async () => {
    await setSetting('demoKey', 'before');
    expect(await getSetting('demoKey')).toBe('before');

    await setSetting('demoKey', 'after');
    expect(await getSetting('demoKey')).toBe('after');
  });

  /**
   * The backstop that actually bounds staleness. Another Cloud Run instance's
   * write invalidates nothing here, so expiry is the only thing that makes this
   * process notice it.
   */
  it('re-reads once the entry has expired', async () => {
    await setSetting('demoKey', 'before');
    expect(await getSetting('demoKey')).toBe('before');

    // A write from "another instance": straight to the table, no invalidation.
    await SystemSetting.upsert({ key: 'demoKey', value: 'from elsewhere' });
    expect(await getSetting('demoKey')).toBe('before');

    const realNow = Date.now;
    Date.now = () => realNow() + SETTINGS_TTL_MS + 1;
    try {
      expect(await getSetting('demoKey')).toBe('from elsewhere');
    } finally {
      Date.now = realNow;
    }
  });

  it('caches the absence of a row and still honours the fallback', async () => {
    expect(await getSetting('neverSet', 'fallback')).toBe('fallback');
    // Served from the cached "no row", and the fallback is applied per call —
    // so a second caller asking for a different default gets its own.
    expect(await getSetting('neverSet', 'other')).toBe('other');
  });

  /**
   * A read that throws must not be cached. `maintenanceModeOn` treats a failed
   * read as "not in maintenance", so a cached failure would be a platform-wide
   * lockout — or its opposite — held for the whole TTL.
   */
  it('does not cache a failed read', async () => {
    const original = SystemSetting.findByPk;
    SystemSetting.findByPk = jest.fn(async () => { throw new Error('database is away'); });

    await expect(getSetting('demoKey', 'fallback')).rejects.toThrow('database is away');

    SystemSetting.findByPk = original;
    await SystemSetting.upsert({ key: 'demoKey', value: 'recovered' });
    expect(await getSetting('demoKey')).toBe('recovered');
  });
});
