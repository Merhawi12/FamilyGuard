const request = require('supertest');
const { app } = require('../src/app');
const { AppRule, Child, Location } = require('../src/models');
const { createUser, tokenFor, createChild, createDevice, deviceToken } = require('./helpers');

describe('Authorization & IDOR', () => {
  describe('POST /api/locations (device-authenticated)', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const res = await request(app)
        .post('/api/locations')
        .send({ childId: 'x', deviceId: 'y', latitude: 1, longitude: 2 });
      expect(res.status).toBe(401);
    });

    it('derives childId from the device token and IGNORES a spoofed body childId', async () => {
      const parent = await createUser();
      const child = await createChild(parent.id);
      const device = await createDevice(child.id);

      // Attacker supplies a different childId in the body — it must be ignored.
      const res = await request(app)
        .post('/api/locations')
        .set('Authorization', `Bearer ${deviceToken(device)}`)
        .send({ childId: 'spoofed-child-id', deviceId: 'spoofed-device', latitude: 40, longitude: -70 });

      expect(res.status).toBe(201);
      const saved = await Location.findOne({ where: { deviceId: device.id } });
      expect(saved).toBeTruthy();
      expect(saved.childId).toBe(child.id); // from token, not body
    });
  });

  describe('Blocking rule deletion ownership (M5)', () => {
    it('does not let another parent delete a rule (404, rule survives)', async () => {
      const owner = await createUser();
      const child = await createChild(owner.id);
      const rule = await AppRule.create({ childId: child.id, appName: 'TikTok', appPackage: 'com.tiktok', action: 'block' });

      const attacker = await createUser();
      const res = await request(app)
        .delete(`/api/blocking/${child.id}/apps/${rule.id}`)
        .set('Authorization', `Bearer ${tokenFor(attacker)}`);

      expect(res.status).toBe(404);
      expect(await AppRule.findByPk(rule.id)).toBeTruthy(); // not deleted
    });

    it('lets the owning parent delete their rule (200)', async () => {
      const owner = await createUser();
      const child = await createChild(owner.id);
      const rule = await AppRule.create({ childId: child.id, appName: 'YT', appPackage: 'com.yt', action: 'block' });

      const res = await request(app)
        .delete(`/api/blocking/${child.id}/apps/${rule.id}`)
        .set('Authorization', `Bearer ${tokenFor(owner)}`);

      expect(res.status).toBe(200);
      expect(await AppRule.findByPk(rule.id)).toBeNull();
    });
  });

  describe('Mass-assignment guard on child update (M6)', () => {
    it('ignores a body parentId, only applies whitelisted fields', async () => {
      const owner = await createUser();
      const otherParent = await createUser();
      const child = await createChild(owner.id, { name: 'Old' });

      const res = await request(app)
        .put(`/api/children/${child.id}`)
        .set('Authorization', `Bearer ${tokenFor(owner)}`)
        .send({ name: 'New', parentId: otherParent.id, isActive: false });

      expect(res.status).toBe(200);
      const reloaded = await Child.findByPk(child.id);
      expect(reloaded.name).toBe('New');
      expect(reloaded.parentId).toBe(owner.id); // NOT reassigned
      expect(reloaded.isActive).toBe(true);     // not whitelisted → unchanged
    });
  });

  describe('Cross-tenant read (IDOR)', () => {
    it('does not expose another parent\'s child screen-time (404)', async () => {
      const owner = await createUser();
      const child = await createChild(owner.id);
      const attacker = await createUser();

      const res = await request(app)
        .get(`/api/screen-time/${child.id}`)
        .set('Authorization', `Bearer ${tokenFor(attacker)}`);

      expect(res.status).toBe(404);
    });
  });

  describe('Admin role escalation (M7)', () => {
    it('forbids a support user (with manage_users) from promoting anyone to admin (403)', async () => {
      const support = await createUser({ role: 'support', permissions: ['manage_users'] });
      const victim = await createUser({ role: 'parent' });

      const res = await request(app)
        .patch(`/api/admin/users/${victim.id}/role`)
        .set('Authorization', `Bearer ${tokenFor(support)}`)
        .send({ role: 'admin', permissions: [] });

      expect(res.status).toBe(403);
    });

    it('allows a full admin to change a role (200)', async () => {
      const admin = await createUser({ role: 'admin' });
      const target = await createUser({ role: 'parent' });

      const res = await request(app)
        .patch(`/api/admin/users/${target.id}/role`)
        .set('Authorization', `Bearer ${tokenFor(admin)}`)
        .send({ role: 'support', permissions: ['manage_users'] });

      expect(res.status).toBe(200);
      expect(res.body.role).toBe('support');
    });
  });
});
