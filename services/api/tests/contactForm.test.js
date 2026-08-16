/**
 * The public contact form: received, stored, notified, acknowledged.
 *
 * The old shape validated, called the mailer, and answered — so a submission
 * existed only as an email in flight. When the relay was down, or `ADMIN_EMAIL`
 * was simply unset (the default for a deployment nobody had configured), the
 * message was *gone*, and the visitor was told to try again with no record
 * anywhere that they had written at all.
 *
 * The row is written before anything is sent now, and that inverts what a
 * delivery failure means: it is no longer the sender's problem to solve by
 * resending — which would only duplicate something already held — but an
 * operator's, logged as one. These tests pin that ordering, because it is the
 * whole reason the endpoint is trustworthy, and it is invisible from the
 * outside.
 */
const request = require('supertest');
const { app } = require('../src/app');
const email = require('../src/utils/email');
const { ContactMessage } = require('../src/models');
const { flushBackground } = require('../src/utils/background');
const { MIN_FILL_SECONDS } = require('../src/utils/contactSpam');

const VALID = { name: 'Sam', email: 'sam@example.com', message: 'Hello there' };

/** A submission that passes the timing check. */
const typed = (overrides = {}) => ({
  ...VALID,
  renderedAt: Date.now() - (MIN_FILL_SECONDS + 5) * 1000,
  ...overrides,
});

const post = (body) => request(app).post('/api/contact').send(body);

/** Both sends succeed unless a test says otherwise. */
const mockMail = ({ notify = true, receipt = true } = {}) => {
  const notifySpy = jest.spyOn(email, 'sendContactFormEmail').mockResolvedValue(notify);
  const receiptSpy = jest.spyOn(email, 'sendContactFormReceiptEmail').mockResolvedValue(receipt);
  return { notifySpy, receiptSpy };
};

beforeEach(() => ContactMessage.destroy({ where: {} }));
afterEach(() => jest.restoreAllMocks());

describe('validation', () => {
  it.each([
    ['no name', { ...VALID, name: '' }],
    ['no email', { ...VALID, email: '' }],
    ['no message', { ...VALID, message: '' }],
    ['whitespace for a name', { ...VALID, name: '   ' }],
    ['a non-string message', { ...VALID, message: { $ne: null } }],
  ])('refuses a submission with %s', async (_label, body) => {
    mockMail();
    const res = await post(body);
    expect(res.status).toBe(400);
  });

  it('refuses a malformed address', async () => {
    mockMail();
    expect((await post({ ...VALID, email: 'not-an-address' })).status).toBe(400);
  });

  it('refuses a message over the length ceiling', async () => {
    mockMail();
    expect((await post({ ...VALID, message: 'x'.repeat(5001) })).status).toBe(400);
  });

  it('stores nothing for a submission it refuses', async () => {
    mockMail();
    await post({ ...VALID, email: 'nope' });
    expect(await ContactMessage.count()).toBe(0);
  });
});

describe('every submission is stored', () => {
  it('writes the message before answering, and hands back its reference', async () => {
    mockMail();
    const res = await post(typed());

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.reference).toBeTruthy();

    const row = await ContactMessage.findByPk(res.body.reference);
    expect(row).toBeTruthy();
    expect(row.name).toBe('Sam');
    expect(row.email).toBe('sam@example.com');
    expect(row.message).toBe('Hello there');
  });

  it('normalises the address it stores, so the duplicate check can match on it', async () => {
    mockMail();
    const res = await post(typed({ email: '  SAM@Example.COM ' }));
    const row = await ContactMessage.findByPk(res.body.reference);
    expect(row.email).toBe('sam@example.com');
  });

  /**
   * The check the whole redesign exists for. This is the deployment default —
   * no ADMIN_EMAIL — and it used to lose the message outright.
   */
  it('keeps the message even when nobody can be notified', async () => {
    mockMail({ notify: false });

    const res = await post(typed());
    await flushBackground();

    expect(res.status).toBe(202);
    const row = await ContactMessage.findByPk(res.body.reference);
    expect(row.message).toBe('Hello there');
    expect(row.status).toBe('failed');
    expect(row.deliveryError).toBeTruthy();
  });

  it('keeps the message when the relay throws outright', async () => {
    jest.spyOn(email, 'sendContactFormEmail').mockRejectedValue(new Error('relay exploded'));
    jest.spyOn(email, 'sendContactFormReceiptEmail').mockResolvedValue(false);

    const res = await post(typed());
    await flushBackground();

    expect(res.status).toBe(202);
    const row = await ContactMessage.findByPk(res.body.reference);
    expect(row.status).toBe('failed');
    // The relay's own words are recorded for the operator...
    expect(row.deliveryError).toMatch(/exploded/);
    // ...and never reach the visitor.
    expect(JSON.stringify(res.body)).not.toMatch(/exploded/);
  });

  it('answers 5xx only when it could not store the message', async () => {
    // The one failure that is still the sender's problem, so "try again" is the
    // right advice for it and for nothing else.
    jest.spyOn(ContactMessage, 'create').mockRejectedValue(new Error('database is gone'));
    mockMail();

    const res = await post(typed());

    expect(res.status).toBe(500);
    expect(res.body.success).toBeUndefined();
    expect(res.body.error).toMatch(/try again/i);
    expect(JSON.stringify(res.body)).not.toMatch(/database/);
  });
});

describe('the notification', () => {
  it('goes to the operator with the sender set as reply-to material', async () => {
    const { notifySpy } = mockMail();

    const res = await post(typed());
    await flushBackground();

    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Sam',
      email: 'sam@example.com',
      message: 'Hello there',
      reference: res.body.reference,
    }));
  });

  it('records that it landed', async () => {
    mockMail();
    const res = await post(typed());
    await flushBackground();

    const row = await ContactMessage.findByPk(res.body.reference);
    expect(row.status).toBe('notified');
    expect(row.notifiedAt).toBeTruthy();
    expect(row.deliveryError).toBeNull();
  });

  it('does not block the response on the mail relay', async () => {
    // A relay that takes seconds must not make the form look broken when the
    // message is already saved.
    let release;
    jest.spyOn(email, 'sendContactFormEmail')
      .mockImplementation(() => new Promise((r) => { release = () => r(true); }));
    jest.spyOn(email, 'sendContactFormReceiptEmail').mockResolvedValue(true);

    const res = await post(typed());
    expect(res.status).toBe(202);

    release();
    await flushBackground();
    expect((await ContactMessage.findByPk(res.body.reference)).status).toBe('notified');
  });
});

describe('the sender is acknowledged', () => {
  it('emails them a copy of what was received', async () => {
    const { receiptSpy } = mockMail();

    const res = await post(typed());
    await flushBackground();

    expect(receiptSpy).toHaveBeenCalledWith(expect.objectContaining({
      email: 'sam@example.com',
      message: 'Hello there',
      reference: res.body.reference,
    }));
    expect((await ContactMessage.findByPk(res.body.reference)).receiptSent).toBe(true);
  });

  /**
   * The two sends are independent on purpose: a typo in the sender's own address
   * is common, and it must not cost the operator their notification.
   */
  it('still notifies the operator when the acknowledgement bounces', async () => {
    const { notifySpy } = mockMail({ receipt: false });
    jest.spyOn(email, 'sendContactFormReceiptEmail').mockRejectedValue(new Error('no such mailbox'));

    const res = await post(typed());
    await flushBackground();

    expect(notifySpy).toHaveBeenCalled();
    const row = await ContactMessage.findByPk(res.body.reference);
    expect(row.status).toBe('notified');
    expect(row.receiptSent).toBe(false);
  });

  it('still acknowledges the sender when the operator cannot be reached', async () => {
    const { receiptSpy } = mockMail({ notify: false });

    const res = await post(typed());
    await flushBackground();

    expect(receiptSpy).toHaveBeenCalled();
    expect((await ContactMessage.findByPk(res.body.reference)).receiptSent).toBe(true);
  });
});

describe('spam protection', () => {
  /**
   * Every refusal is stored and answered exactly like an acceptance. These
   * checks can be wrong, and the cost of being wrong is a real customer who
   * believes they reached support and did not — so the message is kept and
   * findable, and what a refusal actually costs is the notification.
   */
  const expectHeld = async (res, reason) => {
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    const row = await ContactMessage.findByPk(res.body.reference);
    expect(row.status).toBe('spam');
    expect(row.spamReason).toMatch(reason);
    return row;
  };

  it('holds a submission that filled the honeypot', async () => {
    const { notifySpy } = mockMail();
    const res = await post(typed({ honeypot: 'Acme Corp' }));
    await flushBackground();

    await expectHeld(res, /honeypot/);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('holds a form submitted faster than anyone could type it', async () => {
    const { notifySpy } = mockMail();
    const res = await post({ ...VALID, renderedAt: Date.now() });
    await flushBackground();

    await expectHeld(res, /too_fast/);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('does not hold a submission that simply omits the timestamp', async () => {
    // A cached older page, or a client that strips it. Absence must never be
    // held against a sender.
    const { notifySpy } = mockMail();
    const res = await post(VALID);
    await flushBackground();

    expect((await ContactMessage.findByPk(res.body.reference)).status).toBe('notified');
    expect(notifySpy).toHaveBeenCalled();
  });

  it('holds a message that is mostly links', async () => {
    mockMail();
    const res = await post(typed({
      message: 'Check https://a.example https://b.example https://c.example https://d.example',
    }));
    await expectHeld(res, /too_many_links/);
  });

  it('allows a genuine message that happens to cite a link', async () => {
    mockMail();
    const res = await post(typed({
      message: 'The pricing page at https://parentix.ca/#pricing does not load for me.',
    }));
    await flushBackground();
    expect((await ContactMessage.findByPk(res.body.reference)).status).toBe('notified');
  });

  it('holds unsolicited marketing', async () => {
    mockMail();
    const res = await post(typed({ message: 'We offer SEO services and link building.' }));
    await expectHeld(res, /phrase/);
  });

  it('does not fire on a phrase buried inside a longer word', async () => {
    // The failure mode of every naive keyword list: refusing real mail because a
    // banned string appears as a substring of something innocent. "backlink" is
    // listed; "backlinks" inside a sentence about a school website is not a pitch.
    mockMail();
    const res = await post(typed({ message: 'Our school site has backlinking issues, unrelated.' }));
    await flushBackground();
    expect((await ContactMessage.findByPk(res.body.reference)).status).toBe('notified');
  });

  /**
   * The check that matters most on *this* product, and the one an obvious spam
   * list gets exactly backwards.
   *
   * Parentix sells child safety, so the parents who write in are precisely the
   * people who mention gambling ads, crypto apps and follower-buying — as
   * problems. A topic-based filter would refuse the messages this company most
   * needs to read, and since a refusal is silent by design the parent would
   * believe they had reached support and never learn otherwise.
   */
  it.each([
    'My daughter is being shown casino bonus ads inside a game. Can you block that?',
    'Is there a way to stop crypto investment apps installing on her phone?',
    'He used a site to buy followers and now gets strange messages. Help?',
    'Can Parentix block binary options and forex signals channels?',
  ])('lets a worried parent describe the very thing spam sells: %s', async (message) => {
    mockMail();
    const res = await post(typed({ message }));
    await flushBackground();
    expect((await ContactMessage.findByPk(res.body.reference)).status).toBe('notified');
  });

  it('holds the same message sent twice by the same person', async () => {
    const { notifySpy } = mockMail();
    const first = await post(typed());
    await flushBackground();
    const second = await post(typed());
    await flushBackground();

    expect((await ContactMessage.findByPk(first.body.reference)).status).toBe('notified');
    await expectHeld(second, /duplicate/);
    // Notified exactly once, for the first.
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  it('lets the same person send a different message', async () => {
    mockMail();
    await post(typed());
    await flushBackground();
    const second = await post(typed({ message: 'Actually, one more thing.' }));
    await flushBackground();

    expect((await ContactMessage.findByPk(second.body.reference)).status).toBe('notified');
  });

  it('never tells the sender which check caught them', async () => {
    // Naming the check is the one thing that would let a bot tune past it, and
    // an accusation a person cannot argue with is worse than useless.
    mockMail();
    const res = await post(typed({ honeypot: 'x' }));
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/spam|honeypot|blocked|rejected/i);
  });
});
