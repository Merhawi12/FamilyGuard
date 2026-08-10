/**
 * List endpoints take `limit`/`offset` straight from the query string. Feeding
 * `parseInt` output to Sequelize unchecked put `NaN` into the SQL, so a typo in
 * a URL became a 500 rather than a sensible page.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { parsePagination } = require('../src/utils/pagination');
const { createUser, tokenFor, createChild } = require('./helpers');
const { ROLES } = require('../src/config/roles');

describe('parsePagination', () => {
  it('falls back to the defaults when nothing is supplied', () => {
    expect(parsePagination({}, { max: 200, defaultLimit: 50 })).toEqual({ limit: 50, offset: 0 });
  });

  it('ignores values that are not numbers', () => {
    expect(parsePagination({ limit: 'abc', offset: 'xyz' }, { max: 200, defaultLimit: 50 }))
      .toEqual({ limit: 50, offset: 0 });
  });

  it('caps the page size at the endpoint maximum', () => {
    expect(parsePagination({ limit: '10000' }, { max: 200, defaultLimit: 50 }).limit).toBe(200);
  });

  it('refuses a negative or zero page size', () => {
    expect(parsePagination({ limit: '0' }, { max: 200, defaultLimit: 50 }).limit).toBe(1);
    expect(parsePagination({ limit: '-5' }, { max: 200, defaultLimit: 50 }).limit).toBe(1);
  });

  it('refuses a negative offset', () => {
    expect(parsePagination({ offset: '-20' }, { max: 200, defaultLimit: 50 }).offset).toBe(0);
  });

  it('reads a plain numeric string', () => {
    expect(parsePagination({ limit: '25', offset: '75' }, { max: 200, defaultLimit: 50 }))
      .toEqual({ limit: 25, offset: 75 });
  });
});

describe('list endpoints survive junk pagination', () => {
  const junk = '?limit=abc&offset=-1';

  it('admin user directory', async () => {
    const admin = await createUser({ role: ROLES.SUPER_ADMIN });
    await request(app).get(`/api/admin/users${junk}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .expect(200);
  });

  it('active sessions', async () => {
    const admin = await createUser({ role: ROLES.SUPER_ADMIN });
    await request(app).get(`/api/admin/sessions/active${junk}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .expect(200);
  });

  it('audit log', async () => {
    const admin = await createUser({ role: ROLES.SUPER_ADMIN });
    await request(app).get(`/api/audit${junk}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .expect(200);
  });

  it('transactions', async () => {
    const admin = await createUser({ role: ROLES.SUPER_ADMIN });
    await request(app).get(`/api/admin/transactions${junk}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .expect(200);
  });

  it('notifications', async () => {
    const user = await createUser();
    await request(app).get(`/api/notifications${junk}`)
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .expect(200);
  });

  it('child activity', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    await request(app).get(`/api/activity/${child.id}${junk}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .expect(200);
  });

  it('chat thread', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    await request(app).get(`/api/chats/${child.id}/messages${junk}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .expect(200);
  });

  it('location history', async () => {
    const parent = await createUser({ plan: 'premium' });
    const child = await createChild(parent.id);
    await request(app).get(`/api/locations/${child.id}/history${junk}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .expect(200);
  });
});
