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

/**
 * The parent-facing `GET /:childId/messages` needs a parent session, so without
 * this route the child app could send messages but never see the conversation.
 */
describe('Chat REST — child device reads its own thread', () => {
  it('returns the thread for the child in the device token', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const token = tokenFor(parent);

    await request(app).post(`/api/chats/${child.id}/messages`)
      .set('Authorization', `Bearer ${token}`).send({ text: 'from parent' });
    await request(app).post(`/api/chats/${child.id}/messages/from-child`)
      .set('Authorization', `Bearer ${deviceToken(device)}`).send({ text: 'from child' });

    const res = await request(app).get('/api/chats/me/messages')
      .set('Authorization', `Bearer ${deviceToken(device)}`);

    expect(res.status).toBe(200);
    expect(res.body.rows.map((m) => m.text)).toEqual(['from parent', 'from child']);
    expect(res.body.count).toBe(2);
  });

  it('marks the parent\'s messages read once the child opens the thread', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    await request(app).post(`/api/chats/${child.id}/messages`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`).send({ text: 'unread' });

    await request(app).get('/api/chats/me/messages').set('Authorization', `Bearer ${deviceToken(device)}`);

    const message = await Message.findOne({ where: { childId: child.id, senderRole: 'parent' } });
    expect(message.isRead).toBe(true);
  });

  it('never leaks another family\'s thread', async () => {
    const [mine, theirs] = [await createUser(), await createUser()];
    const myChild = await createChild(mine.id);
    const theirChild = await createChild(theirs.id);
    const myDevice = await createDevice(myChild.id);

    await request(app).post(`/api/chats/${theirChild.id}/messages`)
      .set('Authorization', `Bearer ${tokenFor(theirs)}`).send({ text: 'private' });

    const res = await request(app).get('/api/chats/me/messages')
      .set('Authorization', `Bearer ${deviceToken(myDevice)}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  it('refuses a parent session and an unauthenticated caller', async () => {
    const parent = await createUser();
    await createChild(parent.id);

    expect((await request(app).get('/api/chats/me/messages')).status).toBe(401);
    expect((await request(app).get('/api/chats/me/messages')
      .set('Authorization', `Bearer ${tokenFor(parent)}`)).status).toBe(401);
  });

  it('paginates', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    for (let i = 0; i < 3; i += 1) {
      await request(app).post(`/api/chats/${child.id}/messages`)
        .set('Authorization', `Bearer ${tokenFor(parent)}`).send({ text: `m${i}` });
    }

    const res = await request(app).get('/api/chats/me/messages?limit=2&offset=0')
      .set('Authorization', `Bearer ${deviceToken(device)}`);

    expect(res.body.rows).toHaveLength(2);
    expect(res.body.count).toBe(3);
  });
});
