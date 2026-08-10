/**
 * The public contact form has to say whether the message actually went out.
 *
 * `sendContactFormEmail` reports failure by resolving false — for a rejected
 * relay, and for the far more common case of a deployment with no `ADMIN_EMAIL`
 * set at all. The controller used to ignore that and answer `{ success: true }`
 * either way, so the one signal a visitor gets was "sent" for a message that had
 * gone nowhere.
 */
const request = require('supertest');
const { app } = require('../src/app');
const email = require('../src/utils/email');

const VALID = { name: 'Sam', email: 'sam@example.com', message: 'Hello there' };

afterEach(() => jest.restoreAllMocks());

describe('POST /api/contact — validation', () => {
  it.each([
    ['no name', { ...VALID, name: '' }],
    ['no email', { ...VALID, email: '' }],
    ['no message', { ...VALID, message: '' }],
  ])('refuses a submission with %s', async (_label, body) => {
    const res = await request(app).post('/api/contact').send(body);
    expect(res.status).toBe(400);
  });

  it('refuses a malformed address', async () => {
    const res = await request(app).post('/api/contact').send({ ...VALID, email: 'not-an-address' });
    expect(res.status).toBe(400);
  });

  it('refuses a message over the length ceiling', async () => {
    const res = await request(app).post('/api/contact').send({ ...VALID, message: 'x'.repeat(5001) });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/contact — delivery is reported honestly', () => {
  it('answers success when the message was delivered', async () => {
    jest.spyOn(email, 'sendContactFormEmail').mockResolvedValue(true);

    const res = await request(app).post('/api/contact').send(VALID);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, delivered: true });
  });

  it('does not claim success when the message was not delivered', async () => {
    jest.spyOn(email, 'sendContactFormEmail').mockResolvedValue(false);

    const res = await request(app).post('/api/contact').send(VALID);

    expect(res.status).toBe(502);
    expect(res.body.success).toBeUndefined();
    expect(res.body.error).toMatch(/could not send/i);
  });

  it('answers 500, not a success, when the mailer throws', async () => {
    jest.spyOn(email, 'sendContactFormEmail').mockRejectedValue(new Error('relay exploded'));

    const res = await request(app).post('/api/contact').send(VALID);

    expect(res.status).toBe(500);
    expect(res.body.success).toBeUndefined();
    // The relay's own words never reach a visitor.
    expect(JSON.stringify(res.body)).not.toMatch(/exploded/);
  });
});
