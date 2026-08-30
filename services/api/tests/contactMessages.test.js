/**
 * The console's contact-form inbox.
 *
 * The form has stored the message before attempting any email since 2026-08-14,
 * so a dead relay costs the notification and never the message. Nothing could
 * read those rows: the model was written by the form, matched against by the
 * duplicate check, deleted by account erasure, and shown to nobody. These three
 * endpoints are the half that collects on the guarantee — `resend` above all,
 * which is what makes a backlog held while SMTP was down recoverable.
 */
const request = require('supertest');
const { app } = require('../src/app');
const email = require('../src/utils/email');
const { ContactMessage } = require('../src/models');
const { createUser, tokenFor } = require('./helpers');

const LIST = '/api/admin/contact-messages';

const seed = (overrides = {}) => ContactMessage.create({
  name: 'Sam Parent',
  email: 'sam@example.com',
  message: 'My son keeps getting past the bedtime lock.',
  status: 'new',
  ...overrides,
});

let staff;
let token;

beforeEach(async () => {
  await ContactMessage.destroy({ where: {} });
  staff = await createUser({ role: 'support', permissions: ['view_contact_messages'] });
  token = tokenFor(staff);
});

afterEach(() => jest.restoreAllMocks());

const get = (query = '') => request(app).get(`${LIST}${query}`).set('Authorization', `Bearer ${token}`);

describe('who may open the inbox', () => {
  it('refuses an unauthenticated caller', async () => {
    await request(app).get(LIST).expect(401);
  });

  it('refuses a parent', async () => {
    const parent = await createUser({ role: 'parent' });
    const res = await request(app).get(LIST).set('Authorization', `Bearer ${tokenFor(parent)}`);
    expect(res.status).toBe(403);
  });

  /**
   * The point of giving this its own permission rather than folding it into
   * `manage_users`: a department that can read the customer directory is not
   * automatically entitled to a stranger's enquiry, and vice versa.
   */
  it('refuses staff who hold every other permission but this one', async () => {
    const ops = await createUser({
      role: 'operations',
      permissions: ['manage_users', 'manage_sessions', 'manage_settings', 'view_audit_logs', 'reset_passwords'],
    });
    const res = await request(app).get(LIST).set('Authorization', `Bearer ${tokenFor(ops)}`);
    expect(res.status).toBe(403);
  });

  it('admits a Super Admin, who holds every permission implicitly', async () => {
    const boss = await createUser({ role: 'super_admin', permissions: [] });
    await request(app).get(LIST).set('Authorization', `Bearer ${tokenFor(boss)}`).expect(200);
  });
});

describe('listing', () => {
  it('returns messages newest first', async () => {
    await seed({ email: 'older@example.com', createdAt: new Date('2026-01-01') });
    await seed({ email: 'newer@example.com', createdAt: new Date('2026-06-01') });

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.email)).toEqual(['newer@example.com', 'older@example.com']);
    expect(res.body.count).toBe(2);
  });

  it('never returns the submitter fingerprint', async () => {
    await seed({ ipHash: 'abc123', userAgent: 'Mozilla/5.0' });

    const res = await get();
    expect(res.body.rows[0]).not.toHaveProperty('ipHash');
    expect(res.body.rows[0]).not.toHaveProperty('userAgent');
    // …while still carrying what the screen actually shows.
    expect(res.body.rows[0].message).toContain('bedtime lock');
  });

  it('searches the name, the address and the body', async () => {
    await seed({ name: 'Wilhelmina', email: 'w@example.com', message: 'nothing special' });
    await seed({ name: 'Other', email: 'other@example.com', message: 'a question about geofencing' });

    expect((await get('?q=wilhelmina')).body.count).toBe(1);
    expect((await get('?q=geofencing')).body.count).toBe(1);
    expect((await get('?q=other@example')).body.count).toBe(1);
  });

  it('filters by state', async () => {
    await seed({ status: 'failed' });
    await seed({ status: 'notified' });
    await seed({ status: 'spam' });

    const res = await get('?status=failed');
    expect(res.body.count).toBe(1);
    expect(res.body.rows[0].status).toBe('failed');
  });

  /**
   * The tiles describe the inbox, so they must not move when the table below is
   * narrowed — the same rule the user and device directories follow. An operator
   * filtering to `failed` needs to keep seeing how many that is out of how many.
   */
  it('summarises the whole inbox regardless of the filters', async () => {
    await seed({ status: 'failed' });
    await seed({ status: 'failed' });
    await seed({ status: 'notified' });
    await seed({ status: 'spam' });

    const res = await get('?status=failed&q=bedtime');
    expect(res.body.count).toBe(2);
    expect(res.body.summary).toMatchObject({ total: 4, failed: 2, notified: 1, spam: 1, new: 0 });
  });

  it('paginates', async () => {
    for (let i = 0; i < 3; i += 1) await seed({ email: `p${i}@example.com` });

    const res = await get('?limit=2&offset=0');
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.count).toBe(3);
  });
});

describe('changing what a message is', () => {
  const patch = (id, body) => request(app)
    .patch(`${LIST}/${id}`).set('Authorization', `Bearer ${token}`).send(body);

  it('restores a false positive and forgets why it was refused', async () => {
    const row = await seed({ status: 'spam', spamReason: 'phrase:seo services' });

    const res = await patch(row.id, { status: 'new' });
    expect(res.status).toBe(200);

    await row.reload();
    expect(row.status).toBe('new');
    // Leaving the reason would keep the row explaining a refusal somebody
    // has since decided was wrong.
    expect(row.spamReason).toBeNull();
  });

  it('archives a message that has been dealt with', async () => {
    const row = await seed({ status: 'notified' });
    await patch(row.id, { status: 'archived' }).expect(200);
    await row.reload();
    expect(row.status).toBe('archived');
  });

  /**
   * `notified` and `failed` are findings, not opinions: they record what the
   * mailer did. Letting an operator type one in would make "failed" stop
   * reliably meaning "nobody was told".
   */
  it.each(['notified', 'failed', 'anything-else'])('refuses to set %s by hand', async (status) => {
    const row = await seed({ status: 'new' });
    const res = await patch(row.id, { status });
    expect(res.status).toBe(400);
    await row.reload();
    expect(row.status).toBe('new');
  });

  it('404s for a message that does not exist', async () => {
    await patch('11111111-1111-4111-8111-111111111111', { status: 'archived' }).expect(404);
  });
});

describe('retrying a notification', () => {
  const resend = (id) => request(app)
    .post(`${LIST}/${id}/resend`).set('Authorization', `Bearer ${token}`);

  it('delivers, and the row stops saying nobody was told', async () => {
    jest.spyOn(email, 'sendContactFormEmail').mockResolvedValue(true);
    const receipt = jest.spyOn(email, 'sendContactFormReceiptEmail').mockResolvedValue(true);
    const row = await seed({ status: 'failed', deliveryError: 'connect ECONNREFUSED' });

    const res = await resend(row.id);
    expect(res.status).toBe(200);
    expect(res.body.delivered).toBe(true);

    await row.reload();
    expect(row.status).toBe('notified');
    expect(row.notifiedAt).toBeTruthy();
    expect(row.deliveryError).toBeNull();

    /**
     * The sender is not acknowledged twice. They were already told their message
     * arrived — possibly weeks ago — and a second "thanks for getting in touch"
     * for one message reads as a system out of control rather than one
     * recovering.
     */
    expect(receipt).not.toHaveBeenCalled();
  });

  it('reports the reason when it fails again', async () => {
    jest.spyOn(email, 'sendContactFormEmail').mockRejectedValue(new Error('relay still down'));
    const row = await seed({ status: 'failed', deliveryError: 'connect ECONNREFUSED' });

    const res = await resend(row.id);
    expect(res.status).toBe(200);
    expect(res.body.delivered).toBe(false);
    expect(res.body.deliveryError).toContain('relay still down');

    await row.reload();
    expect(row.status).toBe('failed');
  });

  it('leaves the sender receipt flag alone rather than clearing it', async () => {
    jest.spyOn(email, 'sendContactFormEmail').mockResolvedValue(true);
    jest.spyOn(email, 'sendContactFormReceiptEmail').mockResolvedValue(true);
    const row = await seed({ status: 'failed', receiptSent: true });

    await resend(row.id).expect(200);
    await row.reload();
    expect(row.receiptSent).toBe(true);
  });

  it('404s for a message that does not exist', async () => {
    await resend('11111111-1111-4111-8111-111111111111').expect(404);
  });
});
