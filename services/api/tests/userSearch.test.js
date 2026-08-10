/**
 * The staff console's user search must ignore case.
 *
 * This is one of the cases SQLite cannot catch: its `LIKE` already ignores ASCII
 * case, so a plain `Op.like` passes here and fails on Cloud SQL, where `LIKE` is
 * case-sensitive. Run with `npm run test:pg` to exercise the engine that
 * actually decides the answer.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { createUser, tokenFor } = require('./helpers');
const { ROLES } = require('../src/config/roles');

// The schema is created once per file, so each case needs its own subject
// rather than re-inserting the same address in a beforeEach.
const TARGET = 'Wilhelmina Featherstone';

let admin;

beforeAll(async () => {
  admin = await createUser({ role: ROLES.SUPER_ADMIN, name: 'The Administrator' });
  await createUser({ name: TARGET, email: 'Wilhelmina.F@Example.com' });
});

const search = async (term) => {
  const res = await request(app)
    .get(`/api/admin/users?search=${encodeURIComponent(term)}`)
    .set('Authorization', `Bearer ${tokenFor(admin)}`)
    .expect(200);
  return res.body.rows.map((u) => u.name);
};

describe('admin user search', () => {
  it('matches a name typed in the same case', async () => {
    expect(await search('Wilhelmina')).toContain(TARGET);
  });

  it('matches a name typed entirely in lower case', async () => {
    expect(await search('wilhelmina')).toContain(TARGET);
  });

  it('matches a name typed entirely in upper case', async () => {
    expect(await search('FEATHERSTONE')).toContain(TARGET);
  });

  it('matches a fragment of the email regardless of case', async () => {
    expect(await search('WILHELMINA.F')).toContain(TARGET);
  });

  it('returns nothing for a term that matches nobody', async () => {
    expect(await search('zzz-no-such-person')).toEqual([]);
  });
});
