const request = require('supertest');
const { app } = require('../src/app');
const { normalizeDomain } = require('../src/utils/domain');
const { createUser, tokenFor, createChild } = require('./helpers');

const premium = () => createUser({ plan: 'premium' });

describe('normalizeDomain', () => {
  it.each([
    ['example.com', 'example.com'],
    ['  Example.COM  ', 'example.com'],
    ['https://example.com', 'example.com'],
    ['http://example.com/', 'example.com'],
    ['https://www.example.com/feed?a=1#top', 'example.com'],
    ['www.example.com', 'example.com'],
    ['example.com:8443', 'example.com'],
    ['user:pw@example.com', 'example.com'],
    ['example.com.', 'example.com'],
    ['sub.example.co.uk', 'sub.example.co.uk'],
  ])('normalises %s → %s', (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['not a domain', 'spaces'],
    ['localhost', 'no dot'],
    ['http://', 'scheme only'],
    ['-bad.com', 'leading hyphen'],
    ['example..com', 'empty label'],
    [null, 'null'],
    [42, 'a number'],
  ])('rejects %s (%s)', (input) => {
    expect(normalizeDomain(input)).toBeNull();
  });
});

/**
 * The device blocks by matching DNS queries, so a rule that is not a bare
 * hostname can never match. Storing one would look like it worked and block
 * nothing at all.
 */
describe('website rules are stored as bare hostnames', () => {
  const addRule = async (url) => {
    const parent = await premium();
    const child = await createChild(parent.id);
    const res = await request(app)
      .post(`/api/blocking/${child.id}/websites`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ url, action: 'block' });
    return res;
  };

  it('strips the scheme, path and www a parent pasted from the address bar', async () => {
    const res = await addRule('https://www.YouTube.com/feed/subscriptions');
    expect(res.status).toBe(201);
    expect(res.body.url).toBe('youtube.com');
  });

  it('keeps a bare domain untouched', async () => {
    const res = await addRule('example.com');
    expect(res.status).toBe(201);
    expect(res.body.url).toBe('example.com');
  });

  it('rejects something that could never match a DNS query', async () => {
    const res = await addRule('this is not a website');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/domain/i);
  });

  it('still allows a category-only rule with no url', async () => {
    const parent = await premium();
    const child = await createChild(parent.id);

    const res = await request(app)
      .post(`/api/blocking/${child.id}/websites`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ category: 'adult', action: 'block' });

    expect(res.status).toBe(201);
    expect(res.body.category).toBe('adult');
  });

  it('hands the device a domain it can actually match', async () => {
    const parent = await premium();
    const child = await createChild(parent.id);
    const token = tokenFor(parent);

    await request(app).post(`/api/blocking/${child.id}/websites`)
      .set('Authorization', `Bearer ${token}`).send({ url: 'https://bad.example.com/x', action: 'block' });

    const rules = await request(app).get(`/api/blocking/${child.id}/websites`)
      .set('Authorization', `Bearer ${token}`);

    expect(rules.body[0].url).toBe('bad.example.com');
  });
});
