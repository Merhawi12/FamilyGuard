const request = require('supertest');
const { app } = require('../src/app');
const { Message, Alert } = require('../src/models');
const { createUser, tokenFor, createChild, createDevice, deviceToken } = require('./helpers');

describe('Chat REST — parent side', () => {
  it('sends a parent→child message (201) and lists it back', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);

    const send = await request(app)
      .post(`/api/chats/${child.id}/messages`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ text: 'Hello sweetie' });
    expect(send.status).toBe(201);
    expect(send.body.senderRole).toBe('parent');

    const list = await request(app)
      .get(`/api/chats/${child.id}/messages`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`);
    expect(list.status).toBe(200);
    expect(list.body.rows.map((m) => m.text)).toContain('Hello sweetie');
  });

  it('rejects an empty message (400)', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const res = await request(app)
      .post(`/api/chats/${child.id}/messages`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ text: '   ' });
    expect(res.status).toBe(400);
  });

  it('does not let another parent read or post to a child (404)', async () => {
    const owner = await createUser();
    const child = await createChild(owner.id);
    const attacker = await createUser();

    const read = await request(app)
      .get(`/api/chats/${child.id}/messages`)
      .set('Authorization', `Bearer ${tokenFor(attacker)}`);
    expect(read.status).toBe(404);

    const post = await request(app)
      .post(`/api/chats/${child.id}/messages`)
      .set('Authorization', `Bearer ${tokenFor(attacker)}`)
      .send({ text: 'intrusion' });
    expect(post.status).toBe(404);
  });

  it('marks unread child messages as read when the parent fetches the thread', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    await Message.create({ parentId: parent.id, childId: child.id, senderId: child.id, senderRole: 'child', text: 'hi mom', isRead: false });

    await request(app)
      .get(`/api/chats/${child.id}/messages`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`);

    const msg = await Message.findOne({ where: { childId: child.id, senderRole: 'child' } });
    expect(msg.isRead).toBe(true);
  });
});

describe('Chat REST — child device side (from-child)', () => {
  it('requires device authentication (401)', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const res = await request(app)
      .post(`/api/chats/${child.id}/messages/from-child`)
      .send({ text: 'unauthorized' });
    expect(res.status).toBe(401);
  });

  it('accepts a device-authenticated message and derives the child from the token', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    // Spoof a different childId in the URL — it must be ignored.
    const res = await request(app)
      .post(`/api/chats/some-other-child/messages/from-child`)
      .set('Authorization', `Bearer ${deviceToken(device)}`)
      .send({ text: 'hi from kid' });

    expect(res.status).toBe(201);
    expect(res.body.senderRole).toBe('child');
    expect(res.body.childId).toBe(child.id); // from token, not URL
  });

  it('raises an emergency alert for an emergency message', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    const res = await request(app)
      .post(`/api/chats/${child.id}/messages/from-child`)
      .set('Authorization', `Bearer ${deviceToken(device)}`)
      .send({ text: 'help me', messageType: 'emergency' });
    expect(res.status).toBe(201);

    const alert = await Alert.findOne({ where: { parentId: parent.id, type: 'emergency_button' } });
    expect(alert).toBeTruthy();
    expect(alert.childId).toBe(child.id);
  });
});
