const request = require('supertest');
const { app } = require('../src/app');
const storage = require('../src/services/storage');
const { Child } = require('../src/models');
const { createUser, tokenFor, createChild } = require('./helpers');

const PUBLIC_BASE = 'https://app.parentix.test/media';

describe('POST /api/uploads/child-avatar', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app)
      .post('/api/uploads/child-avatar')
      .send({ childId: 'x', contentType: 'image/png' });

    expect(res.status).toBe(401);
  });

  it("will not sign an upload for another parent's child", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const child = await createChild(owner.id);

    const res = await request(app)
      .post('/api/uploads/child-avatar')
      .set('Authorization', `Bearer ${tokenFor(stranger)}`)
      .send({ childId: child.id, contentType: 'image/png' });

    expect(res.status).toBe(404);
  });

  it('rejects a content type that is not an allowed image', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);

    const res = await request(app)
      .post('/api/uploads/child-avatar')
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ childId: child.id, contentType: 'application/x-msdownload' });

    expect(res.status).toBe(400);
  });

  it('rejects a file larger than the configured maximum', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);

    const res = await request(app)
      .post('/api/uploads/child-avatar')
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ childId: child.id, contentType: 'image/png', contentLength: 6 * 1024 * 1024 });

    expect(res.status).toBe(413);
  });

  it("signs an upload scoped to the requesting parent's own key prefix", async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);

    const res = await request(app)
      .post('/api/uploads/child-avatar')
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ childId: child.id, contentType: 'image/jpeg', contentLength: 2048 });

    expect(res.status).toBe(200);
    // The key is server-generated: a caller cannot choose where it writes.
    expect(res.body.key).toMatch(new RegExp(`^child-avatars/${parent.id}/[0-9a-f-]+\\.jpg$`));
    expect(res.body.url).toBe(`${PUBLIC_BASE}/${res.body.key}`);
    expect(res.body.uploadUrl).toContain(res.body.key);
  });
});

describe('child avatarUrl validation', () => {
  it('stores a URL the service issued to this parent', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const url = `${PUBLIC_BASE}/child-avatars/${parent.id}/photo.jpg`;

    const res = await request(app)
      .put(`/api/children/${child.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ avatarUrl: url });

    expect(res.status).toBe(200);
    expect(res.body.avatarUrl).toBe(url);
  });

  it("rejects a URL pointing at another parent's object", async () => {
    const parent = await createUser();
    const victim = await createUser();
    const child = await createChild(parent.id);

    const res = await request(app)
      .put(`/api/children/${child.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ avatarUrl: `${PUBLIC_BASE}/child-avatars/${victim.id}/photo.jpg` });

    expect(res.status).toBe(400);
    await child.reload();
    expect(child.avatarUrl).toBeFalsy();
  });

  it('rejects a URL on a host the service never issued', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);

    const res = await request(app)
      .put(`/api/children/${child.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ avatarUrl: 'https://evil.test/child-avatars/x/photo.jpg' });

    expect(res.status).toBe(400);
  });

  it('deletes the replaced object when the photo changes', async () => {
    const { __reset, __sent } = require('@aws-sdk/client-s3');
    __reset();

    const parent = await createUser();
    const oldKey = `child-avatars/${parent.id}/old.jpg`;
    const child = await createChild(parent.id, { avatarUrl: `${PUBLIC_BASE}/${oldKey}` });

    const res = await request(app)
      .put(`/api/children/${child.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ avatarUrl: `${PUBLIC_BASE}/child-avatars/${parent.id}/new.jpg` });

    expect(res.status).toBe(200);

    // The delete is fire-and-forget, so let the microtask queue drain.
    await new Promise((resolve) => setImmediate(resolve));

    const deletes = __sent.filter((command) => command.name === 'DeleteObjectCommand');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].input.Key).toBe(oldKey);
  });

  it('clears the photo when an empty value is sent', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id, {
      avatarUrl: `${PUBLIC_BASE}/child-avatars/${parent.id}/old.jpg`,
    });

    const res = await request(app)
      .put(`/api/children/${child.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ avatarUrl: '' });

    expect(res.status).toBe(200);
    const reloaded = await Child.findByPk(child.id);
    expect(reloaded.avatarUrl).toBeNull();
  });
});

describe('storage.ownedKeyFromUrl', () => {
  const owner = 'aaaaaaaa-0000-0000-0000-000000000001';
  const other = 'bbbbbbbb-0000-0000-0000-000000000002';
  const scope = { prefix: 'child-avatars', ownerId: owner };

  it("accepts the owner's own object", () => {
    expect(storage.ownedKeyFromUrl(`${PUBLIC_BASE}/child-avatars/${owner}/photo.jpg`, scope)).toBe(
      `child-avatars/${owner}/photo.jpg`
    );
  });

  it.each([
    ['another tenant', `${PUBLIC_BASE}/child-avatars/${other}/photo.jpg`],
    ['a different prefix', `${PUBLIC_BASE}/backups/${owner}/dump.sql`],
    ['a traversal out of the prefix', `${PUBLIC_BASE}/child-avatars/${owner}/../${other}/photo.jpg`],
    ['a foreign host', `https://evil.test/child-avatars/${owner}/photo.jpg`],
    ['an empty value', ''],
  ])('rejects %s', (_label, url) => {
    expect(storage.ownedKeyFromUrl(url, scope)).toBeNull();
  });
});

describe('storage when the provider is not configured', () => {
  it('reports disabled and refuses to sign with a 503', async () => {
    // Only the storage module is reloaded here — it imports no models, so the
    // suite's in-memory database is untouched.
    process.env.STORAGE_PROVIDER = 'none';
    process.env.S3_BUCKET = '';

    let error;
    await jest.isolateModulesAsync(async () => {
      const isolated = require('../src/services/storage');
      expect(isolated.isEnabled()).toBe(false);
      error = await isolated
        .createImageUploadUrl({ prefix: 'child-avatars', ownerId: 'someone', contentType: 'image/png' })
        .catch((err) => err);
    });

    process.env.STORAGE_PROVIDER = 's3';
    process.env.S3_BUCKET = 'parentix-uploads-test';

    expect(error.status).toBe(503);
  });
});
