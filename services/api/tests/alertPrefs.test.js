/**
 * Whether an alert turns into an email.
 *
 * Three preferences gate it and they had no coverage, which is how
 * "High severity only" came to be a switch that changed nothing.
 */
const { createAlert } = require('../src/utils/alertHelper');
const { createUser, createChild } = require('./helpers');

jest.mock('../src/utils/email', () => ({ sendAlertEmail: jest.fn(async () => {}) }));
const { sendAlertEmail } = require('../src/utils/email');

// createAlert only broadcasts through this; the rooms themselves are covered by
// the socket suite.
const io = { to: () => ({ emit: () => {} }) };

const raise = async (parent, child, overrides = {}) =>
  createAlert(io, {
    parentId: parent.id,
    childId: child.id,
    type: 'left_safe_zone',
    message: 'Child left School',
    severity: 'high',
    ...overrides,
  });

let parent;
let child;

beforeEach(async () => {
  sendAlertEmail.mockClear();
  parent = await createUser();
  child = await createChild(parent.id);
});

const setPrefs = (prefs) => parent.update({ notificationPrefs: JSON.stringify(prefs) });

describe('alert emails', () => {
  it('emails a high-severity alert by default', async () => {
    await raise(parent, child);
    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
  });

  it('records the alert whether or not an email goes out', async () => {
    await setPrefs({ emailAlerts: false });
    const alert = await raise(parent, child);
    expect(alert.id).toBeTruthy();
    expect(sendAlertEmail).not.toHaveBeenCalled();
  });

  it('sends nothing when email alerts are switched off', async () => {
    await setPrefs({ emailAlerts: false });
    await raise(parent, child);
    expect(sendAlertEmail).not.toHaveBeenCalled();
  });

  it('sends nothing for a type the parent has switched off', async () => {
    await setPrefs({ alertTypes: { left_safe_zone: false } });
    await raise(parent, child);
    expect(sendAlertEmail).not.toHaveBeenCalled();
  });

  it('still sends for a type the parent has left on', async () => {
    await setPrefs({ alertTypes: { left_safe_zone: true } });
    await raise(parent, child);
    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
  });

  describe('"High severity only"', () => {
    it('holds back a medium alert while it is on', async () => {
      await setPrefs({ emailHighOnly: true });
      await raise(parent, child, { severity: 'medium', type: 'entered_safe_zone' });
      expect(sendAlertEmail).not.toHaveBeenCalled();
    });

    it('sends a medium alert once it is switched off', async () => {
      await setPrefs({ emailHighOnly: false });
      await raise(parent, child, { severity: 'medium', type: 'entered_safe_zone' });
      expect(sendAlertEmail).toHaveBeenCalledTimes(1);
    });

    it('still sends high-severity alerts either way', async () => {
      await setPrefs({ emailHighOnly: false });
      await raise(parent, child);
      expect(sendAlertEmail).toHaveBeenCalledTimes(1);
    });

    it('defaults to on, so a medium alert is not emailed unprompted', async () => {
      await raise(parent, child, { severity: 'medium', type: 'entered_safe_zone' });
      expect(sendAlertEmail).not.toHaveBeenCalled();
    });
  });

  it('every default alert type is one the platform can actually raise', async () => {
    const request = require('supertest');
    const { app } = require('../src/app');
    const { tokenFor } = require('./helpers');

    const res = await request(app)
      .get('/api/auth/notification-prefs')
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .expect(200);

    // Grepped from the code that calls createAlert. A toggle outside this set
    // promises the parent an alert nothing can send.
    //
    // `unknown_contact` is in the set now: the socket handler for it had always
    // existed, but nothing emitted it, so the toggle was withheld. The child
    // app's contact policy (services/contacts.js) raises it once the device
    // holds an approved-contact list, which is what makes it real.
    const producible = [
      'emergency_button', 'cyberbullying', 'left_safe_zone', 'entered_safe_zone',
      'safety_pattern', 'screen_time_exceeded', 'blocked_app_attempt', 'unknown_contact',
    ];
    expect(Object.keys(res.body.alertTypes).sort()).toEqual([...producible].sort());
  });
});
