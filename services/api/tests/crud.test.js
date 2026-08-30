const request = require('supertest');
const { app } = require('../src/app');
const { Child, ScreenTimeRule, Contact, SafeZone } = require('../src/models');
const { createUser, tokenFor, createChild } = require('./helpers');

describe('Children CRUD & ownership', () => {
  it('creates a child and auto-provisions a screen-time rule', async () => {
    const parent = await createUser();
    const res = await request(app)
      .post('/api/children')
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ name: 'Ava', age: 8 });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Ava');
    const rule = await ScreenTimeRule.findOne({ where: { childId: res.body.id } });
    expect(rule).toBeTruthy();
  });

  it('lists only the requesting parent\'s children', async () => {
    const owner = await createUser();
    const other = await createUser();
    const mine = await createChild(owner.id, { name: 'Mine' });
    await createChild(other.id, { name: 'Theirs' });

    const res = await request(app)
      .get('/api/children')
      .set('Authorization', `Bearer ${tokenFor(owner)}`);

    expect(res.status).toBe(200);
    const ids = res.body.map((c) => c.id);
    expect(ids).toContain(mine.id);
    expect(res.body.every((c) => c.parentId === owner.id)).toBe(true);
  });

  it('soft-deletes a child (removed from the active list)', async () => {
    const owner = await createUser();
    const child = await createChild(owner.id);

    const del = await request(app)
      .delete(`/api/children/${child.id}`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`);
    expect(del.status).toBe(200);

    const reloaded = await Child.findByPk(child.id);
    expect(reloaded.isActive).toBe(false);

    const list = await request(app)
      .get('/api/children')
      .set('Authorization', `Bearer ${tokenFor(owner)}`);
    expect(list.body.map((c) => c.id)).not.toContain(child.id);
  });
});

describe('Contacts CRUD & ownership', () => {
  it('requires a child that belongs to the parent (404 on cross-tenant childId)', async () => {
    const owner = await createUser();
    const attacker = await createUser();
    const child = await createChild(owner.id);

    const res = await request(app)
      .post('/api/contacts')
      .set('Authorization', `Bearer ${tokenFor(attacker)}`)
      .send({ childId: child.id, name: 'Grandma' });

    expect(res.status).toBe(404);
  });

  it('creates a contact and blocks another parent from deleting it', async () => {
    const owner = await createUser();
    const child = await createChild(owner.id);
    const created = await request(app)
      .post('/api/contacts')
      .set('Authorization', `Bearer ${tokenFor(owner)}`)
      .send({ childId: child.id, name: 'Grandma', phoneNumber: '555-1212' });
    expect(created.status).toBe(201);

    const attacker = await createUser();
    const del = await request(app)
      .delete(`/api/contacts/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenFor(attacker)}`);
    expect(del.status).toBe(404);
    expect(await Contact.findByPk(created.body.id)).toBeTruthy();
  });
});

describe('Safe zones (feature-gated) & ownership', () => {
  it('blocks a free-plan user with 403 (feature gate)', async () => {
    const free = await createUser({ plan: 'free' });
    const res = await request(app)
      .get('/api/safe-zones')
      .set('Authorization', `Bearer ${tokenFor(free)}`);
    expect(res.status).toBe(403);
    expect(res.body.upgradeRequired).toBe(true);
  });

  it('allows a premium user to create a zone', async () => {
    const premium = await createUser({ plan: 'premium' });
    const res = await request(app)
      .post('/api/safe-zones')
      .set('Authorization', `Bearer ${tokenFor(premium)}`)
      .send({ name: 'Home', latitude: 40.1, longitude: -74.2, radiusMeters: 150 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Home');
  });

  it('update ignores non-whitelisted fields and enforces ownership', async () => {
    const premium = await createUser({ plan: 'premium' });
    const zone = await SafeZone.create({ parentId: premium.id, name: 'Z', latitude: 1, longitude: 2 });

    // parentId in body must be ignored by the whitelist
    const upd = await request(app)
      .put(`/api/safe-zones/${zone.id}`)
      .set('Authorization', `Bearer ${tokenFor(premium)}`)
      .send({ name: 'Renamed', parentId: 'someone-else' });
    expect(upd.status).toBe(200);
    const reloaded = await SafeZone.findByPk(zone.id);
    expect(reloaded.name).toBe('Renamed');
    expect(reloaded.parentId).toBe(premium.id);

    // another premium parent cannot touch it
    const attacker = await createUser({ plan: 'premium' });
    const bad = await request(app)
      .put(`/api/safe-zones/${zone.id}`)
      .set('Authorization', `Bearer ${tokenFor(attacker)}`)
      .send({ name: 'Hacked' });
    expect(bad.status).toBe(404);
  });

  /**
   * The list a child's screen shows has to be the list that fires for them.
   *
   * `childId` is nullable — an unscoped zone applies to the whole family, and
   * `checkGeofences` matches `[{ childId }, { childId: null }]` accordingly.
   * Filtering the list on the column alone hid every such zone from every
   * child's Location screen, so its alerts arrived from a geofence with no row,
   * no toggle and no circle on the map.
   */
  it('lists a family-wide zone under each child, and another child’s zone under neither', async () => {
    const premium = await createUser({ plan: 'premium' });
    const ada = await createChild(premium.id, { name: 'Ada' });
    const ben = await createChild(premium.id, { name: 'Ben' });

    const familyWide = await SafeZone.create({ parentId: premium.id, name: 'Home', latitude: 1, longitude: 2 });
    const adaOnly = await SafeZone.create({ parentId: premium.id, childId: ada.id, name: 'School', latitude: 3, longitude: 4 });

    const forChild = async (childId) => {
      const res = await request(app)
        .get(`/api/safe-zones?childId=${childId}`)
        .set('Authorization', `Bearer ${tokenFor(premium)}`);
      expect(res.status).toBe(200);
      return res.body.map((z) => z.id).sort();
    };

    expect(await forChild(ada.id)).toEqual([familyWide.id, adaOnly.id].sort());
    expect(await forChild(ben.id)).toEqual([familyWide.id]);

    // Unfiltered still means everything this parent owns.
    const all = await request(app)
      .get('/api/safe-zones')
      .set('Authorization', `Bearer ${tokenFor(premium)}`);
    expect(all.body.map((z) => z.id).sort()).toEqual([familyWide.id, adaOnly.id].sort());
  });
});
