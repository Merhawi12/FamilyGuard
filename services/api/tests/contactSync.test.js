const request = require('supertest');
const { app } = require('../src/app');
const { Contact } = require('../src/models');
const { createUser, tokenFor, createChild, createDevice, deviceToken } = require('./helpers');

/**
 * The contact-sync contract, from the parent's edit through to what a device is
 * allowed to read back.
 *
 * The point of most of these is that "the parent UI says approved" and "the
 * device can see it" are separate claims: the approval is only real once the
 * device-authenticated read reflects it.
 */
describe('Approved contacts — device sync', () => {
  const addContact = (parent, body) =>
    request(app).post('/api/contacts').set('Authorization', `Bearer ${tokenFor(parent)}`).send(body);

  const deviceContacts = (device) =>
    request(app).get('/api/devices/me/contacts').set('Authorization', `Bearer ${deviceToken(device)}`);

  it('delivers an approved contact to the child\'s device', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    const created = await addContact(parent, {
      childId: child.id, name: 'Grandma', phoneNumber: '+1 555 010 0199', relationship: 'family',
    });
    expect(created.status).toBe(201);

    const res = await deviceContacts(device);
    expect(res.status).toBe(200);
    expect(res.body.contacts).toHaveLength(1);
    expect(res.body.contacts[0]).toMatchObject({ name: 'Grandma', phoneNumber: '+1 555 010 0199' });
    expect(res.body.syncedAt).toBeTruthy();

    // Database and API agree — the UI is not the source of truth for either.
    const row = await Contact.findByPk(created.body.id);
    expect(row.isApproved).toBe(true);
    expect(row.childId).toBe(child.id);
    expect(row.parentId).toBe(parent.id);
  });

  it('withholds a contact the parent has not approved, and delivers it once they do', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    const created = await addContact(parent, { childId: child.id, name: 'Coach', phoneNumber: '5550100' });

    await request(app)
      .put(`/api/contacts/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ isApproved: false });

    let res = await deviceContacts(device);
    expect(res.body.contacts).toHaveLength(0);

    await request(app)
      .put(`/api/contacts/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ isApproved: true });

    res = await deviceContacts(device);
    expect(res.body.contacts.map((c) => c.name)).toEqual(['Coach']);
  });

  it('removes a deleted contact from the device list', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    const created = await addContact(parent, { childId: child.id, name: 'Neighbour', phoneNumber: '5550111' });
    await request(app)
      .delete(`/api/contacts/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`);

    const res = await deviceContacts(device);
    expect(res.body.contacts).toHaveLength(0);
    expect(await Contact.findByPk(created.body.id)).toBeNull();
  });

  it('propagates an edit to the contact\'s details', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    const created = await addContact(parent, { childId: child.id, name: 'Aunt', phoneNumber: '5550122' });
    await request(app)
      .put(`/api/contacts/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ phoneNumber: '5550133', name: 'Aunt Mae' });

    const res = await deviceContacts(device);
    expect(res.body.contacts[0]).toMatchObject({ name: 'Aunt Mae', phoneNumber: '5550133' });
  });

  it('never sends the parent\'s private notes to the device', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    await addContact(parent, {
      childId: child.id, name: 'Teacher', phoneNumber: '5550144',
      notes: 'Do not let Ada call after 6pm',
    });

    const res = await deviceContacts(device);
    expect(res.body.contacts[0]).not.toHaveProperty('notes');
    expect(JSON.stringify(res.body)).not.toContain('Do not let Ada call');
  });

  it('repeated syncs return the same list without duplicating it', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    await addContact(parent, { childId: child.id, name: 'Uncle', phoneNumber: '5550155' });

    const first = await deviceContacts(device);
    const second = await deviceContacts(device);
    const third = await deviceContacts(device);

    expect(first.body.contacts).toHaveLength(1);
    expect(second.body.contacts).toEqual(first.body.contacts);
    expect(third.body.contacts).toEqual(first.body.contacts);
  });

  it('returns an empty list rather than an error when nothing is approved', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    const res = await deviceContacts(device);
    expect(res.status).toBe(200);
    expect(res.body.contacts).toEqual([]);
  });
});

describe('Approved contacts — isolation and authorization', () => {
  it('never shows one child\'s contacts to another child\'s device', async () => {
    const parent = await createUser();
    const ada = await createChild(parent.id, { name: 'Ada' });
    const ben = await createChild(parent.id, { name: 'Ben' });
    const adaDevice = await createDevice(ada.id);
    const benDevice = await createDevice(ben.id);

    await request(app).post('/api/contacts').set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ childId: ada.id, name: 'Ada Friend', phoneNumber: '5550166' });

    const onAda = await request(app).get('/api/devices/me/contacts')
      .set('Authorization', `Bearer ${deviceToken(adaDevice)}`);
    const onBen = await request(app).get('/api/devices/me/contacts')
      .set('Authorization', `Bearer ${deviceToken(benDevice)}`);

    expect(onAda.body.contacts.map((c) => c.name)).toEqual(['Ada Friend']);
    expect(onBen.body.contacts).toEqual([]);
  });

  it('never shows one family\'s contacts to another family\'s device', async () => {
    const parentA = await createUser();
    const childA = await createChild(parentA.id);
    await request(app).post('/api/contacts').set('Authorization', `Bearer ${tokenFor(parentA)}`)
      .send({ childId: childA.id, name: 'Family A Contact', phoneNumber: '5550177' });

    const parentB = await createUser();
    const childB = await createChild(parentB.id);
    const deviceB = await createDevice(childB.id);

    const res = await request(app).get('/api/devices/me/contacts')
      .set('Authorization', `Bearer ${deviceToken(deviceB)}`);
    expect(res.body.contacts).toEqual([]);
  });

  it('rejects a device read with no token, a malformed token, and a parent token', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    await createDevice(child.id);

    expect((await request(app).get('/api/devices/me/contacts')).status).toBe(401);

    expect((await request(app).get('/api/devices/me/contacts')
      .set('Authorization', 'Bearer not-a-jwt')).status).toBe(401);

    // A parent's own token carries { id }, not { deviceId, childId }.
    expect((await request(app).get('/api/devices/me/contacts')
      .set('Authorization', `Bearer ${tokenFor(parent)}`)).status).toBe(401);
  });

  it('rejects a device token once the device is deactivated', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const token = deviceToken(device);

    expect((await request(app).get('/api/devices/me/contacts')
      .set('Authorization', `Bearer ${token}`)).status).toBe(200);

    await device.update({ isActive: false });

    expect((await request(app).get('/api/devices/me/contacts')
      .set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });

  it('refuses to create a contact against another parent\'s child', async () => {
    const owner = await createUser();
    const child = await createChild(owner.id);
    const attacker = await createUser();

    const res = await request(app).post('/api/contacts')
      .set('Authorization', `Bearer ${tokenFor(attacker)}`)
      .send({ childId: child.id, name: 'Injected', phoneNumber: '5550188' });
    expect(res.status).toBe(404);
    expect(await Contact.count({ where: { childId: child.id } })).toBe(0);
  });

  it('refuses to approve or delete a contact belonging to another parent', async () => {
    const owner = await createUser();
    const child = await createChild(owner.id);
    const created = await request(app).post('/api/contacts')
      .set('Authorization', `Bearer ${tokenFor(owner)}`)
      .send({ childId: child.id, name: 'Theirs', phoneNumber: '5550199' });

    const attacker = await createUser();
    const update = await request(app).put(`/api/contacts/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenFor(attacker)}`)
      .send({ isApproved: false });
    expect(update.status).toBe(404);

    const remove = await request(app).delete(`/api/contacts/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenFor(attacker)}`);
    expect(remove.status).toBe(404);

    const row = await Contact.findByPk(created.body.id);
    expect(row).not.toBeNull();
    expect(row.isApproved).toBe(true);
  });
});

describe('Approved contacts — input validation', () => {
  it('requires childId and name', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const token = `Bearer ${tokenFor(parent)}`;

    expect((await request(app).post('/api/contacts').set('Authorization', token)
      .send({ name: 'No Child' })).status).toBe(400);

    expect((await request(app).post('/api/contacts').set('Authorization', token)
      .send({ childId: child.id })).status).toBe(400);
  });

  /**
   * A malformed id must answer "not found", not fail.
   *
   * Every id column is `UUID`. Postgres rejects a value that is not one with
   * `invalid input syntax for type uuid`, which reaches the client as a 500;
   * SQLite has no UUID type and simply matches nothing. Without a guard the two
   * engines disagree, and the SQLite-only run in CI is the one that looks fine.
   */
  it('treats a malformed id as not found rather than erroring', async () => {
    const parent = await createUser();
    const token = `Bearer ${tokenFor(parent)}`;

    for (const bad of ['not-a-uuid', '123', 'null', '../../etc/passwd', "' OR 1=1--"]) {
      const list = await request(app).get('/api/contacts').set('Authorization', token).query({ childId: bad });
      expect(list.status).toBe(404);

      const create = await request(app).post('/api/contacts').set('Authorization', token)
        .send({ childId: bad, name: 'Ghost' });
      expect(create.status).toBe(404);

      const update = await request(app).put(`/api/contacts/${encodeURIComponent(bad)}`)
        .set('Authorization', token).send({ isApproved: true });
      expect(update.status).toBe(404);

      const remove = await request(app).delete(`/api/contacts/${encodeURIComponent(bad)}`)
        .set('Authorization', token);
      expect(remove.status).toBe(404);
    }
  });

  it('404s on an unknown childId and an unknown contact id', async () => {
    const parent = await createUser();
    const token = `Bearer ${tokenFor(parent)}`;
    const missing = '11111111-1111-4111-8111-111111111111';

    expect((await request(app).post('/api/contacts').set('Authorization', token)
      .send({ childId: missing, name: 'Ghost' })).status).toBe(404);

    expect((await request(app).put(`/api/contacts/${missing}`).set('Authorization', token)
      .send({ isApproved: true })).status).toBe(404);

    expect((await request(app).delete(`/api/contacts/${missing}`).set('Authorization', token)).status).toBe(404);
  });
});
