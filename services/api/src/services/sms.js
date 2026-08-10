const { env } = require('../config/env');
const logger = require('../utils/logger');
const { maskPhone } = require('../utils/normalizePhone');

/**
 * One `send({ to, body })` entry point over two transports, mirroring `mailer`:
 *
 *   twilio — a form-encoded POST to Twilio's Messages resource. This is the
 *            production path.
 *   none   — logs the message instead of sending, so development and the test
 *            suite never touch the network.
 *
 * No vendor SDK. The request is four lines of `fetch`, and the Twilio REST shape
 * is the one most other providers imitate, so `SMS_API_BASE_URL` is usually the
 * whole of switching to one of them. A dependency here would buy retries and
 * typings in exchange for a supply-chain surface on the sign-in path.
 *
 * Every function returns a boolean rather than throwing, and the boolean is the
 * point: the caller reports to the browser whether the code actually left the
 * building. An earlier version of the email flow always answered "sent", and a
 * deployment with broken credentials stranded every new account on a screen
 * waiting for a message that was never going out. Phone sign-in has exactly the
 * same failure mode and is spared it the same way.
 */

const isEnabled = () => env.sms.provider === 'twilio'
  && Boolean(env.sms.accountSid && env.sms.authToken)
  && Boolean(env.sms.from || env.sms.messagingServiceSid);

/**
 * Whether phone sign-in can be completed at all, which is not the same question
 * as whether an SMS can be sent.
 *
 * `/auth/providers` reports this rather than `isEnabled()`, and the difference
 * is the whole of why phone sign-in was unreachable in development: with no
 * credentials the sign-in page hid the Phone tab, so the one environment where
 * the code is freely readable was also the one where the flow could not be
 * started. Delivery still reports itself honestly through `smsDelivered` — this
 * only decides whether the door is drawn.
 */
const canVerifyByPhone = () => isEnabled() || env.sms.echoCode;

const sendViaTwilio = async ({ to, body }) => {
  const url = `${env.sms.baseUrl.replace(/\/$/, '')}/2010-04-01/Accounts/${encodeURIComponent(env.sms.accountSid)}/Messages.json`;

  const form = new URLSearchParams({ To: to, Body: body });
  // A messaging service manages a pool of sending numbers and takes precedence;
  // `From` is the single-number case.
  if (env.sms.messagingServiceSid) form.set('MessagingServiceSid', env.sms.messagingServiceSid);
  else form.set('From', env.sms.from);

  const auth = Buffer.from(`${env.sms.accountSid}:${env.sms.authToken}`).toString('base64');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
    // Sign-in blocks on this call. A provider that has stopped answering must
    // fail fast enough to report "we could not send it" rather than holding the
    // request open until something further up gives up on it.
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    // The body carries Twilio's own error code, which is the difference between
    // "unverified number in trial mode" and "your credentials are wrong".
    const detail = await res.text().catch(() => '');
    logger.error('SMS provider rejected the message', {
      to: maskPhone(to),
      status: res.status,
      detail: detail.slice(0, 300),
    });
    return false;
  }

  return true;
};

/**
 * @param {{ to: string, body: string }} message
 * @returns {Promise<boolean>} whether the provider accepted it
 */
const send = async ({ to, body }) => {
  if (!isEnabled()) {
    logger.info('SMS suppressed (no provider configured)', { to: maskPhone(to) });
    return false;
  }

  try {
    return await sendViaTwilio({ to, body });
  } catch (err) {
    logger.error('SMS send failed', { to: maskPhone(to), error: err.message });
    return false;
  }
};

/**
 * The verification code itself.
 *
 * Deliberately terse: this is read off a lock screen, often while the sender is
 * still on the signup form, and carriers split anything over 160 characters into
 * billed segments. The app name leads so the message is identifiable before it
 * is opened, and there is no link — a code in an SMS that also contains a URL is
 * the shape every phishing kit uses, and training people to tap it is worse than
 * making them type six digits.
 */
const sendVerificationSms = ({ phone, code }) => {
  if (!isEnabled()) {
    // Without a provider there is no other way to finish a phone signup locally,
    // exactly as the email path logs its code when mail is disabled.
    logger.info('Phone verification code (SMS disabled)', { phone: maskPhone(phone), code });
    return Promise.resolve(false);
  }
  return send({
    to: phone,
    body: `${code} is your Parentix verification code. It expires in 15 minutes. If you didn't request it, ignore this message.`,
  });
};

module.exports = { send, isEnabled, canVerifyByPhone, sendVerificationSms };
