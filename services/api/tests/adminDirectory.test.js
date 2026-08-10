const request = require('supertest');
const { app } = require('../src/app');
const { User } = require('../src/models');
const { createUser, createChild, createDevice, tokenFor } = require('./helpers');

const bearer = (u) => ({ Authorization: `Bearer ${tokenFor(u)}` });

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

/**
 * Ages an account. `instance.update({ createdAt })` is ignored — Sequelize owns
 * that column — so the write has to name the field explicitly, and `silent`
 * keeps it from bumping `updatedAt` on the way past.
 */
const backdate = (userId, when) => User.update(
  { createdAt: when },
  { where: { id: userId }, fields: ['createdAt'], silent: true },
);

const listUsers = (admin, query = '') => request(app)
  .get(`/api/admin/users${query}`)
  .set(bearer(admin))
  .then((r) => r.body);

/**
 * The extras the User Management screen reads: per-account children and devices
 * on each row, and a directory-wide summary that the filters must not move.
 */
describe('GET /admin/users — the directory screen', () => {
  it('counts each account\'s children and linked devices', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const parent = await createUser({ role: 'parent', name: 'Household Parent' });

    const first = await createChild(parent.id, { name: 'One' });
    const second = await createChild(parent.id, { name: 'Two' });
    await createDevice(first.id);
    await createDevice(first.id, { name: 'Tablet' });
    await createDevice(second.id);

    const { rows } = await listUsers(admin, '?search=Household');
    const row = rows.find((u) => u.id === parent.id);

    expect(row.childCount).toBe(2);
    expect(row.deviceCount).toBe(3);
  });

  it('leaves a removed child or device out of the counts', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const parent = await createUser({ role: 'parent', name: 'Softdelete Parent' });

    const kept = await createChild(parent.id, { name: 'Kept' });
    const gone = await createChild(parent.id, { name: 'Gone' });
    const keptDevice = await createDevice(kept.id);
    const goneDevice = await createDevice(kept.id, { name: 'Old phone' });

    await gone.update({ isActive: false });
    await goneDevice.update({ isActive: false });

    const { rows } = await listUsers(admin, '?search=Softdelete');
    const row = rows.find((u) => u.id === parent.id);

    expect(row.childCount).toBe(1);
    expect(row.deviceCount).toBe(1);
    expect(keptDevice.isActive).toBe(true);
  });

  it('reports zeroes for an account with no family yet', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const parent = await createUser({ role: 'parent', name: 'Lonely Parent' });

    const { rows } = await listUsers(admin, '?search=Lonely');
    const row = rows.find((u) => u.id === parent.id);

    expect(row.childCount).toBe(0);
    expect(row.deviceCount).toBe(0);
  });

  it('summarises customers only — staff are not counted as users', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const before = (await listUsers(admin)).summary;

    await createUser({ role: 'parent' });
    await createUser({ role: 'parent', plan: 'premium' });
    await createUser({ role: 'support', permissions: ['manage_users'] });

    const summary = (await listUsers(admin)).summary;

    // Two customers added; the support account is not one of them.
    expect(summary.customers - before.customers).toBe(2);
    expect(summary.premium - before.premium).toBe(1);
    expect(summary.customers).toBe(summary.active + summary.blocked);
    expect(summary.premiumShare).toBe(Math.round((summary.premium / summary.customers) * 1000) / 10);
  });

  it('counts a blocked account as a customer but not as active', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const before = (await listUsers(admin)).summary;

    await createUser({ role: 'parent', isActive: false });
    const summary = (await listUsers(admin)).summary;

    expect(summary.customers - before.customers).toBe(1);
    expect(summary.active - before.active).toBe(0);
    expect(summary.blocked - before.blocked).toBe(1);
  });

  it('splits signups into this month and the one before, zero-filled by day', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const before = (await listUsers(admin)).summary;

    const fresh = await createUser({ role: 'parent' });
    const older = await createUser({ role: 'parent' });
    const ancient = await createUser({ role: 'parent' });
    await backdate(older.id, daysAgo(45));
    await backdate(ancient.id, daysAgo(120));

    const { signups } = (await listUsers(admin)).summary;

    expect(signups.month - before.signups.month).toBe(1);
    expect(signups.previousMonth - before.signups.previousMonth).toBe(1);
    expect(signups.byDay).toHaveLength(30);
    expect(signups.byDay.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date))).toBe(true);
    // Today's bucket is the last one, and it holds the account just created.
    const today = signups.byDay[signups.byDay.length - 1];
    expect(today.date).toBe(new Date().toISOString().slice(0, 10));
    expect(today.count).toBeGreaterThanOrEqual(1);
    expect(fresh.createdAt.toISOString().slice(0, 10)).toBe(today.date);
  });

  it('summarises the whole directory, not the filtered page', async () => {
    const admin = await createUser({ role: 'super_admin' });
    await createUser({ role: 'parent', name: 'Unfiltered Parent', plan: 'premium' });

    const all = await listUsers(admin);
    const filtered = await listUsers(admin, '?search=Unfiltered&limit=1');

    expect(filtered.rows).toHaveLength(1);
    expect(filtered.count).toBe(1);
    expect(filtered.summary).toEqual(all.summary);
  });
});
