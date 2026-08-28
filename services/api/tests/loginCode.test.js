/**
 * The emailed second factor on every password sign-in.
 *
 * A password alone no longer opens a session: `login` answers with a challenge,
 * and six digits sent to the address on the account turn that into one. These pin
 * the parts that are easy to get wrong in a way nothing else would notice —
 * which sign-ins are exempt, what a failed send means, and the fact that the
 * challenge token is not itself a credential.
 *
 * The exemptions matter as much as the rule. A factor that locks people out is
 * not a security feature, and two of the three cases below would do exactly that
 * if this were applied uniformly: an account with no email address has nowhere to
 * receive a code, and an account that already carries an authenticator has a
 * stronger second factor that does not depend on a mail relay at all.
 */
const request = require('supertest');
const jwt = require('jsonwebtoken');

// Replaced rather than spied on: `utils/email` destructures `send` at module
// load, so a spy attached afterwards would never be the function it calls.
// `isEnabled` true is what makes a failed send a *refusal* rather than the
// no-relay case every other suite runs in.
jest.mock('../src/services/mailer', () => ({
  send: jest.fn().mockResolvedValue(true),
  isEnabled: jest.fn().mockReturnValue(true),
}));

const mailer = require('../src/services/mailer');
const { app } = require('../src/app');
const { User } = require('../src/models');
const { signTrustedDeviceToken } = require('../src/utils/trustedDevice');
const {
  createUser, tokenFor, signIn, seedLoginCode, LOGIN_CODE, DEFAULT_PASSWORD, uniqueEmail,
  rewindOtpCooldown,
} = require('./helpers');

const login = (email, password = DEFAULT_PASSWORD, body = {}) =>
  request(app).post('/api/auth/login').send({ email, password, ...body });

beforeEach(() => {
  mailer.send.mockClear();
  mailer.send.mockResolvedValue(true);
  mailer.isEnabled.mockReturnValue(true);
});

const verify = (body) => request(app).post('/api/auth/login/verify').send(body);

describe('a password sign-in is finished with an emailed code', () => {
  it('answers with a challenge rather than a session', async () => {
    const user = await createUser();

    const res = await login(user.email);

    expect(res.status).toBe(200);
    expect(res.body.loginCodeRequired).toBe(true);
    expect(res.body.preAuthToken).toEqual(expect.any(String));
    // No session, by any name. This is the assertion the whole feature rests on.
    expect(res.body.token).toBeUndefined();
  });

  it('names the inbox without printing the address', async () => {
    const user = await createUser({ email: 'gabriella@example.com' });

    const res = await login(user.email);

    // Enough to tell two of your own addresses apart, not enough to hand the
    // address to whoever is holding a stolen password.
    expect(res.body.email).toBe('g•••••••a@example.com');
    expect(res.body.email).not.toContain('gabriella');
  });

  it('stores the code hashed, never as digits', async () => {
    const user = await createUser();
    await login(user.email);

    const fresh = await User.findByPk(user.id);
    expect(fresh.loginCode).toMatch(/^[a-f0-9]{64}$/);
  });

  it('turns the right code into a session', async () => {
    const user = await createUser();
    const challenge = await login(user.email);
    await seedLoginCode(user);

    const res = await verify({ preAuthToken: challenge.body.preAuthToken, code: LOGIN_CODE });

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user.email).toBe(user.email);
    // Not asked for, so not issued — the bypass is opt-in.
    expect(res.body.trustedDeviceToken).toBeUndefined();
  });

  it('spends the code, so a replay of the same digits fails', async () => {
    const user = await createUser();
    const first = await login(user.email);
    await seedLoginCode(user);
    await verify({ preAuthToken: first.body.preAuthToken, code: LOGIN_CODE }).expect(200);

    const replay = await verify({ preAuthToken: first.body.preAuthToken, code: LOGIN_CODE });
    expect(replay.status).toBe(401);
  });

  it('refuses a wrong code and counts it against the account', async () => {
    const user = await createUser();
    const challenge = await login(user.email);
    await seedLoginCode(user);

    const res = await verify({ preAuthToken: challenge.body.preAuthToken, code: '000000' });

    expect(res.status).toBe(401);
    const fresh = await User.findByPk(user.id);
    // Counted against the account, not only against the code: otherwise a
    // guesser simply asks for a fresh code and starts again.
    expect(fresh.failedLoginAttempts).toBe(1);
  });

  it('refuses an expired code', async () => {
    const user = await createUser();
    const challenge = await login(user.email);
    await user.update({ loginCode: LOGIN_CODE, loginCodeExpires: new Date(Date.now() - 1000) });

    const res = await verify({ preAuthToken: challenge.body.preAuthToken, code: LOGIN_CODE });
    expect(res.status).toBe(401);
  });
});

describe('the challenge token is not a credential', () => {
  it('cannot be used against the API', async () => {
    const user = await createUser();
    const { body } = await login(user.email);

    // The `mfaRequired` claim it carries is what `middleware/auth` refuses. This
    // is the bypass that once made MFA gate nothing but the shape of a response,
    // and the emailed factor reuses that token precisely to inherit the refusal.
    const res = await request(app).get('/api/children').set('Authorization', `Bearer ${body.preAuthToken}`);
    expect(res.status).toBe(401);
  });

  it('is refused by the verify endpoint when it is a full session token', async () => {
    const user = await createUser();
    await login(user.email);
    await seedLoginCode(user);

    const res = await verify({ preAuthToken: tokenFor(user), code: LOGIN_CODE });
    expect(res.status).toBe(400);
  });

  it('will not complete a sign-in for a different account', async () => {
    const victim = await createUser();
    const attacker = await createUser();
    await login(victim.email);
    await seedLoginCode(victim);

    const theirs = await login(attacker.email);
    // The attacker's own challenge plus the victim's code: the token names whose
    // sign-in this is, so the victim's digits are checked against the attacker.
    const res = await verify({ preAuthToken: theirs.body.preAuthToken, code: LOGIN_CODE });
    expect(res.status).toBe(401);
  });
});

describe('who is not challenged, and why', () => {
  it('leaves an account with an authenticator app to its authenticator', async () => {
    const user = await createUser({ mfaEnabled: true, mfaSecret: 'JBSWY3DPEHPK3PXP' });

    const res = await login(user.email);

    // One second factor is the point, and TOTP is the stronger of the two: it
    // needs neither an inbox nor a working relay.
    expect(res.body.mfaRequired).toBe(true);
    expect(res.body.loginCodeRequired).toBeUndefined();
    expect(await User.findByPk(user.id).then((u) => u.loginCode)).toBeFalsy();
  });

  it('does not challenge a phone sign-in', async () => {
    /*
     * The decision that keeps this feature from being a lockout. A phone signup
     * can have `email: null` — there is such a row in production — so an emailed
     * code would go to nobody and the account could never sign in again. Phone
     * sign-in proves possession of the number instead, and comes through
     * `verifyPhoneCode` rather than `login`, which is where the factor lives.
     */
    const user = await User.create({
      name: 'Phone Only', phone: '+15551230000', phoneVerified: true, emailVerified: true,
      phoneVerificationCode: '112233',
      phoneVerificationExpires: new Date(Date.now() + 10 * 60 * 1000),
    });

    const res = await request(app)
      .post('/api/auth/phone/verify')
      .send({ phone: '+15551230000', code: '112233', mode: 'login' });

    expect(res.status).toBe(200);
    expect(res.body.loginCodeRequired).toBeUndefined();
    expect(res.body.token).toEqual(expect.any(String));
    expect(await User.findByPk(user.id).then((u) => u.loginCode)).toBeFalsy();
  });
});

describe('a remembered browser skips the code for thirty days', () => {
  it('issues a token only when asked, and honours it next time', async () => {
    const user = await createUser();
    const challenge = await login(user.email);
    await seedLoginCode(user);

    const first = await verify({
      preAuthToken: challenge.body.preAuthToken, code: LOGIN_CODE, rememberDevice: true,
    });
    expect(first.body.trustedDeviceToken).toEqual(expect.any(String));

    const second = await login(user.email, DEFAULT_PASSWORD, {
      trustedDeviceToken: first.body.trustedDeviceToken,
    });

    expect(second.body.loginCodeRequired).toBeUndefined();
    expect(second.body.token).toEqual(expect.any(String));
  });

  it('does not accept another account\'s token', async () => {
    const user = await createUser();
    const stranger = await createUser();

    const res = await login(user.email, DEFAULT_PASSWORD, {
      trustedDeviceToken: signTrustedDeviceToken(stranger.id),
    });

    // Without the check that the token names *this* user, any account's
    // remembered browser would skip every account's second factor.
    expect(res.body.loginCodeRequired).toBe(true);
  });

  it('ignores a token that is not a trusted-device token', async () => {
    const user = await createUser();

    const res = await login(user.email, DEFAULT_PASSWORD, { trustedDeviceToken: tokenFor(user) });

    // A session token is signed with the same secret and names the same user, so
    // only the purpose claim tells them apart.
    expect(res.body.loginCodeRequired).toBe(true);
  });

  it('stops honouring it once the password changes', async () => {
    const user = await createUser();
    const challenge = await login(user.email);
    await seedLoginCode(user);
    const signedIn = await verify({
      preAuthToken: challenge.body.preAuthToken, code: LOGIN_CODE, rememberDevice: true,
    });
    const trusted = signedIn.body.trustedDeviceToken;

    await request(app)
      .put('/api/auth/password')
      .set('Authorization', `Bearer ${signedIn.body.token}`)
      .send({ currentPassword: DEFAULT_PASSWORD, newPassword: 'brand-new-password-9' })
      .expect(200);

    const res = await login(user.email, 'brand-new-password-9', { trustedDeviceToken: trusted });

    // Changing a password revokes every session; a remembered browser that
    // survived it would be the shorter way back in for whoever prompted it.
    expect(res.body.loginCodeRequired).toBe(true);
  });

  it('is expired rather than merely old', async () => {
    const user = await createUser();
    const stale = jwt.sign(
      { id: user.id, purpose: 'trusted-device' },
      process.env.JWT_SECRET,
      { expiresIn: '-1s' },
    );

    const res = await login(user.email, DEFAULT_PASSWORD, { trustedDeviceToken: stale });
    expect(res.body.loginCodeRequired).toBe(true);
  });
});

describe('asking for another code', () => {
  it('sends one against the challenge, not against an address', async () => {
    const user = await createUser();
    const challenge = await login(user.email);
    const before = await User.findByPk(user.id).then((u) => u.loginCode);

    // The account's own 60-second cooldown has just been started by `login`
    // itself, so without this the resend is correctly refused — which is the
    // policy, and is asserted in otp.test.js rather than worked around here.
    await rewindOtpCooldown(user, 'login');

    const res = await request(app)
      .post('/api/auth/login/resend')
      .send({ preAuthToken: challenge.body.preAuthToken });

    expect(res.status).toBe(200);
    const after = await User.findByPk(user.id).then((u) => u.loginCode);
    expect(after).not.toBe(before);
  });

  it('refuses a token it was not given', async () => {
    const res = await request(app).post('/api/auth/login/resend').send({ preAuthToken: 'nonsense' });
    expect(res.status).toBe(401);
  });
});

/**
 * Signing in twice inside the cooldown, which is what closing the code screen
 * and tapping Sign In again looks like from the server.
 *
 * The account's send cooldown is a minute, and `login` starts it itself — so the
 * second attempt is refused a *send*. Refusing the whole sign-in with it would
 * leave a parent holding a live code from thirty seconds ago and no screen to
 * type it into, renewed every time they retried. The code they already have is
 * good for fifteen minutes, so the challenge is reissued against it.
 */
describe('a second attempt inside the cooldown', () => {
  it('challenges again with the code already sent, rather than refusing', async () => {
    const user = await createUser();
    await login(user.email);
    const issued = await User.findByPk(user.id).then((u) => u.loginCode);

    const again = await login(user.email);

    expect(again.status).toBe(200);
    expect(again.body.loginCodeRequired).toBe(true);
    expect(again.body.codeAlreadySent).toBe(true);
    // What the screen counts down to, so "Resend in Ns" matches when a resend
    // will actually be allowed.
    expect(again.body.retryAfter).toEqual(expect.any(Number));
    expect(again.body.preAuthToken).toEqual(expect.any(String));
  });

  it('does not issue new digits, and the ones already sent still work', async () => {
    const user = await createUser();
    await login(user.email);
    await seedLoginCode(user);
    const before = await User.findByPk(user.id).then((u) => u.loginCode);

    const again = await login(user.email);

    // Nothing was minted and nothing was sent: the whole point is that the
    // message already in the inbox is the one that finishes this.
    expect(await User.findByPk(user.id).then((u) => u.loginCode)).toBe(before);

    const res = await verify({ preAuthToken: again.body.preAuthToken, code: LOGIN_CODE });
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
  });

  it('still refuses once the hourly quota is gone', async () => {
    const user = await createUser();

    // Five sends is the window's whole budget; rewinding only the cooldown
    // between them is what makes them reachable in a test rather than in an hour.
    for (let i = 0; i < 5; i += 1) {
      await login(user.email);
      await rewindOtpCooldown(user, 'login');
      await user.reload();
    }

    const res = await login(user.email);

    // Unlike the cooldown, this window outlives a code's fifteen minutes, so
    // there may be nothing live left to type — and a code screen for a code that
    // does not exist is worse than being told to wait.
    expect(res.status).toBe(429);
    expect(res.body.loginCodeRequired).toBeUndefined();
  });
});

/**
 * A relay that is configured and refuses.
 *
 * Distinct from a deployment with no relay at all, which logs the code instead
 * and is how every local machine and every harness completes this flow. Here the
 * service believes it can send mail and cannot, and the rule is that no session
 * comes out of it: a second factor that lapses precisely when the mail system is
 * unhealthy is indistinguishable from one an attacker has arranged to break.
 */
describe('a sign-in code that could not be delivered', () => {
  it('refuses the sign-in rather than letting the password alone through', async () => {
    const user = await createUser();
    mailer.send.mockResolvedValue(false);

    const res = await login(user.email);

    expect(res.status).toBe(503);
    expect(res.body.loginCodeUndelivered).toBe(true);
    expect(res.body.token).toBeUndefined();
    expect(res.body.preAuthToken).toBeUndefined();
  });

  it('leaves no code and no cooldown behind, so the next try really tries again', async () => {
    const user = await createUser();
    mailer.send.mockResolvedValue(false);
    await login(user.email);

    const fresh = await User.findByPk(user.id);
    expect(fresh.loginCode).toBeFalsy();

    /*
     * Without the rollback this is the bug: `prepareCode` started the account's
     * 60-second cooldown before the relay was asked, so the retry the 503 asks
     * for lands in the reuse branch and is answered with a code screen — for a
     * message that was refused and never sent.
     */
    const again = await login(user.email);
    expect(again.status).toBe(503);
    expect(again.body.loginCodeRequired).toBeUndefined();

    // And once the relay recovers, the very next attempt works — the failure
    // spent nothing.
    mailer.send.mockResolvedValue(true);
    const recovered = await login(user.email);
    expect(recovered.status).toBe(200);
    expect(recovered.body.loginCodeRequired).toBe(true);
  });
});

describe('signing every other device out also withdraws their trust', () => {
  it('challenges a remembered browser again afterwards', async () => {
    const user = await createUser();
    const challenge = await login(user.email);
    await seedLoginCode(user);
    const signedIn = await verify({
      preAuthToken: challenge.body.preAuthToken, code: LOGIN_CODE, rememberDevice: true,
    });
    const trusted = signedIn.body.trustedDeviceToken;

    const revoked = await request(app)
      .delete('/api/auth/sessions/others')
      .set('Authorization', `Bearer ${signedIn.body.token}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.trustedDevicesRevoked).toBe(true);

    const res = await login(user.email, DEFAULT_PASSWORD, { trustedDeviceToken: trusted });

    /*
     * The screen offering this button says "if you do not recognise one, sign it
     * out and change your password" — so the person pressing it may be evicting
     * somebody who has the password. A browser that was signed out but stayed
     * trusted would still hold the one thing that turns that password back into
     * a session with no code in between.
     */
    expect(res.body.loginCodeRequired).toBe(true);
  });
});

describe('the helper the rest of the suite signs in with', () => {
  it('completes both steps and hands back a session', async () => {
    const user = await createUser({ email: uniqueEmail('helper') });

    const res = await signIn(user.email);

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
  });

  it('passes a refusal straight through, without inventing a second step', async () => {
    const user = await createUser();
    const res = await signIn(user.email, 'not-the-password');
    expect(res.status).toBe(401);
  });
});
