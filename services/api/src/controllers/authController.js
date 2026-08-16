const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { User, Session } = require('../models');
const { cancelSubscription } = require('../services/billing');
const { eraseAccount } = require('../utils/accountErasure');
const { sendWelcomeEmail, sendAdminRegistrationNotification, sendVerificationEmail, sendPasswordResetCodeEmail, sendPasswordChangedEmail } = require('../utils/email');
const { auditLog } = require('../utils/auditLogger');
const { createSession, revokeSession, revokeAllSessions, revokeOtherSessions } = require('../utils/session');
const { notifyNewSignIn } = require('../utils/signInNotice');
const { track } = require('../utils/background');
const { serializeUser } = require('../utils/serializers');
// Registration, reset, change and staff account creation all run the same check.
const { passwordProblem } = require('../utils/password');
const { OAuth2Client } = require('google-auth-library');
const { normalizeEmail } = require('../utils/normalizeEmail');
const { isUuid } = require('../utils/ids');
const { getSetting } = require('../utils/settings');
const { blocksSignIn, maintenanceModeOn, MAINTENANCE_MESSAGE } = require('../utils/maintenance');
const { normalizePhone, maskPhone } = require('../utils/normalizePhone');
const { sendVerificationSms, canVerifyByPhone } = require('../services/sms');
const { env } = require('../config/env');
const logger = require('../utils/logger');
/**
 * Every six-digit code on this service is minted, stored, expired, attempt-
 * limited and resend-limited by this one module. What stays here is what a code
 * *means* — which account it activates, whether presenting a wrong one also
 * counts towards the account lockout — because that genuinely differs between
 * confirming an address, signing in by SMS, and recovering a password.
 */
const otp = require('../utils/otp');

/**
 * A resend the recipient is not entitled to yet.
 *
 * Answered as 429 with the wait in seconds, so a client can count down against
 * the server's clock rather than its own guess. Deliberately *not* used by
 * `forgotPassword`, which must answer identically whether or not the address has
 * an account — see the note there.
 */
const throttled = (res, prepared, thing = 'code') =>
  res.status(429).json({
    error: prepared.reason === 'cooldown'
      ? `Please wait ${prepared.retryAfter} seconds before asking for another ${thing}.`
      : `Too many ${thing}s requested for this account. Try again later.`,
    retryAfter: prepared.retryAfter,
  });

/**
 * Every signup path hands out the same trial, and has to.
 *
 * `featureGate.effectivePlan` lifts a `free` account to the trial tier only
 * while `trialEndsAt` is in the future, so an account created without one is a
 * Free account from its first request — no GPS tracking, no geofencing, no
 * website filtering, and the Free device allowance. Phone signup created its
 * user with `{ name, phone }` alone and silently landed every parent who signed
 * up with a number in exactly that state, while the welcome copy promised full
 * access. Kept as one helper so a fourth signup path cannot forget it.
 *
 * Seven days unless an operator says otherwise.
 *
 * "Default trial period" is a field on the console's Settings screen, and it was
 * written to `system_settings` and read by nothing — every signup path used the
 * constant below, so an operator who set 14 days watched every new account
 * carry on getting 7 with nothing to say why. The setting is the source of
 * truth now; the constant is the fallback for a platform that has never been
 * configured, and for a settings read that fails.
 */
const DEFAULT_TRIAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const trialEndsAtFromNow = async () => {
  let days = DEFAULT_TRIAL_DAYS;
  try {
    const configured = Number(await getSetting('defaultTrialDays', DEFAULT_TRIAL_DAYS));
    // A nonsensical value is ignored rather than issued: a zero- or
    // negative-length trial would create accounts that are already expired.
    if (Number.isFinite(configured) && configured > 0) days = Math.floor(configured);
  } catch (err) {
    logger.error('Could not read the trial-length setting — using the default', {
      error: err.message,
      days: DEFAULT_TRIAL_DAYS,
    });
  }
  return new Date(Date.now() + days * DAY_MS);
};

// Short-lived token used as the first-factor proof before MFA is verified
const signPreAuthToken = (id) =>
  jwt.sign({ id, mfaRequired: true }, env.auth.jwtSecret, { expiresIn: '5m' });

const register = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });

    const weak = passwordProblem(password);
    if (weak) return res.status(400).json({ error: weak });

    const existing = await User.findByEmail(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const trialEndsAt = await trialEndsAtFromNow();

    /**
     * The account is created unactivated, and that is the state the code exists
     * to leave: `emailVerified` false is refused by `login`, so until the digits
     * come back this row can hold a place and nothing else. `isActive` is a
     * different question — an operator's decision about an account that already
     * works — and the two are deliberately not the same flag.
     *
     * A brand-new account has no send history, so this cannot be throttled; the
     * same call is what `resendCode` makes, where it can be.
     */
    const prepared = otp.prepareCode({}, 'email');

    const user = await User.create({
      name, email, passwordHash: password, trialEndsAt, ...prepared.fields,
    });

    auditLog(req, { userId: user.id, action: 'auth.register', entity: 'User', entityId: user.id, metadata: { email } });

    /**
     * Awaited, and its result reported.
     *
     * This is the one email the flow cannot proceed without: the account cannot
     * log in until the code is entered, and the code only exists in the email.
     * Fired and forgotten, a rejected SMTP login (an expired app password, a
     * revoked API key) left this endpoint answering "Verification code sent to
     * your email" over an account that had just become permanently unusable,
     * with the reason visible only in a server log. `send()` reports delivery
     * rather than throwing, so the boolean was already there to be read.
     *
     * The account is deliberately still created: it is valid, and "Resend code"
     * finishes the job once mail is working again.
     */
    const emailDelivered = await sendVerificationEmail({ name, email, code: prepared.code });
    if (!emailDelivered) logger.error('Verification email was not delivered', { email });

    // Not on the critical path — nobody is blocked when this one fails.
    track(sendAdminRegistrationNotification({ name, email }));

    res.status(201).json({
      message: emailDelivered
        ? 'Verification code sent to your email'
        : 'Your account was created, but we could not deliver the verification email.',
      email,
      emailDelivered,
    });
  } catch (err) {
    next(err);
  }
};

const verifyEmail = async (req, res, next) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code required' });

    const user = await User.findByEmail(email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.emailVerified) return res.status(400).json({ error: 'Email already verified' });

    if (user.lockedUntil && new Date() < new Date(user.lockedUntil)) {
      auditLog(req, { userId: user.id, action: 'auth.login_blocked_locked', metadata: { email } });
      return res.status(423).json({ error: 'Too many incorrect codes. Try again later.' });
    }

    const checked = otp.checkCode(user, 'email', code);

    if (!checked.ok) {
      /**
       * Counted twice, against two different things, because they stop two
       * different attacks.
       *
       * `otp.checkCode` has already decided what happens to the *code* — five
       * wrong guesses and it is destroyed, so a guesser cannot ride out the
       * route's per-IP limiter from a second address and keep working on the
       * same six digits. What follows counts the failure against the *account*,
       * which is what stops them simply asking for a fresh code and starting
       * again. This code is not a password check — it issues a session — so
       * guessing it is a takeover of a newly registered account.
       */
      const attempts = user.failedLoginAttempts + 1;
      const updates = { ...checked.fields, failedLoginAttempts: attempts };
      if (attempts >= MAX_LOGIN_ATTEMPTS) {
        updates.failedLoginAttempts = 0;
        updates.lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
      }
      await user.update(updates);
      auditLog(req, {
        userId: user.id, action: 'auth.email_code_failed', entity: 'User', entityId: user.id,
        metadata: { reason: checked.reason },
      });
      return res.status(400).json({ error: 'Invalid or expired verification code' });
    }

    // Activation. The address has proved itself, so the account stops being a
    // pending one — and the code that proved it is destroyed by `fields`.
    await user.update({
      ...checked.fields,
      emailVerified: true,
      failedLoginAttempts: 0,
      lockedUntil: null,
    });

    auditLog(req, { userId: user.id, action: 'auth.email_verified', entity: 'User', entityId: user.id });

    /**
     * The deactivation gate `login` has, applied to the other two doors.
     *
     * Verifying an address and signing in are the same event here — this
     * endpoint ends by issuing a session, exactly as `login` does — so it needs
     * the same refusal. Without it an administrator could block an account and
     * the holder would still walk in through the code in their inbox, landing a
     * row in the active-sessions view and a `lastLoginAt` that says they are
     * using a product they have been shut out of.
     *
     * Placed after the code is consumed on purpose: the address really has been
     * proved, and recording that is correct whatever the account's status. What
     * is refused is the session, not the fact.
     */
    if (!user.isActive) {
      auditLog(req, { userId: user.id, action: 'auth.login_blocked_inactive', metadata: { email } });
      return res.status(403).json({ error: 'This account has been deactivated. Contact an administrator.' });
    }

    /**
     * Maintenance mode refuses the session, not the credential.
     *
     * Placed after the account has proved itself and before `createSession`, so
     * the answer does not depend on whether the password was right — and so
     * nothing about who exists leaks through it. Staff pass straight through
     * (see utils/maintenance.js): they are the ones who turn it off.
     */
    if (await blocksSignIn(user)) {
      auditLog(req, { userId: user.id, action: 'auth.login_blocked_maintenance', entity: 'User', entityId: user.id });
      return res.status(503).json({ error: MAINTENANCE_MESSAGE, maintenance: true });
    }

    track(sendWelcomeEmail({ name: user.name, email }));

    // Issue a session-bound token, exactly like login does. A bare JWT would
    // have no Session row and could never be revoked by an admin force-logout.
    const { token, session } = await createSession(req, user.id);
    await user.update({ lastLoginAt: new Date() });
    /**
     * Notified like any other sign-in, even though this is usually the first one.
     *
     * `notifyNewSignIn` suppresses itself when the account has no earlier
     * session, so for a fresh registration this is a no-op — but this endpoint is
     * reached a second time whenever `updateProfile` changes the address, and
     * that caller *does* have a history. Leaving it out here would have made this
     * the one session-issuing path out of five with no notice, which is exactly
     * the "three of four doors" shape the rest of this audit was about.
     */
    track(notifyNewSignIn(req, user, session.id));
    res.json({ token, user: serializeUser(user) });
  } catch (err) {
    next(err);
  }
};

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await User.findByEmail(email);

    if (user?.lockedUntil && new Date() < new Date(user.lockedUntil)) {
      auditLog(req, { userId: user.id, action: 'auth.login_blocked_locked', metadata: { email } });
      return res.status(423).json({ error: 'Account temporarily locked due to repeated failed logins. Try again later.' });
    }

    if (!user || !(await user.comparePassword(password))) {
      if (user) {
        const attempts = user.failedLoginAttempts + 1;
        const updates = { failedLoginAttempts: attempts };
        if (attempts >= MAX_LOGIN_ATTEMPTS) {
          updates.lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
          updates.failedLoginAttempts = 0;
        }
        await user.update(updates);
      }
      auditLog(req, { userId: user?.id, action: 'auth.login_failed', metadata: { email } });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.emailVerified) {
      return res.status(403).json({ error: 'Please verify your email before logging in', emailVerificationRequired: true });
    }

    // A deactivated account must not get as far as a session. `authenticate`
    // already rejects one, so without this the caller is handed a token that
    // fails on its very next request — and a blocked user still lands a row in
    // the active-sessions view.
    if (!user.isActive) {
      auditLog(req, { userId: user.id, action: 'auth.login_blocked_inactive', metadata: { email } });
      return res.status(403).json({ error: 'This account has been deactivated. Contact an administrator.' });
    }

    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      await user.update({ failedLoginAttempts: 0, lockedUntil: null });
    }

    /**
     * Maintenance mode refuses the session, not the credential.
     *
     * Placed after the account has proved itself and before `createSession`, so
     * the answer does not depend on whether the password was right — and so
     * nothing about who exists leaks through it. Staff pass straight through
     * (see utils/maintenance.js): they are the ones who turn it off.
     */
    if (await blocksSignIn(user)) {
      auditLog(req, { userId: user.id, action: 'auth.login_blocked_maintenance', entity: 'User', entityId: user.id });
      return res.status(503).json({ error: MAINTENANCE_MESSAGE, maintenance: true });
    }

    if (user.mfaEnabled) {
      const preAuthToken = signPreAuthToken(user.id);
      auditLog(req, { userId: user.id, action: 'auth.mfa_challenge', entity: 'User', entityId: user.id });
      return res.json({ mfaRequired: true, preAuthToken });
    }

    const { token, session } = await createSession(req, user.id);
    await user.update({ lastLoginAt: new Date() });
    auditLog(req, { userId: user.id, action: 'auth.login', entity: 'User', entityId: user.id });
    // Not awaited: it reaches an SMTP relay, and the person signing in should not
    // wait on that. `notifyNewSignIn` swallows its own failures, so there is no
    // rejection to leak.
    track(notifyNewSignIn(req, user, session.id));
    res.json({ token, user: serializeUser(user) });
  } catch (err) {
    next(err);
  }
};

const me = async (req, res) => {
  res.json(serializeUser(req.user));
};

const logout = async (req, res, next) => {
  try {
    if (req.sessionId) await revokeSession(req.sessionId, req.app.get('io'));
    auditLog(req, { userId: req.user.id, action: 'auth.logout', entity: 'User', entityId: req.user.id });
    res.json({ message: 'Logged out' });
  } catch (err) {
    next(err);
  }
};

const resendCode = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await User.findByEmail(email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.emailVerified) return res.status(400).json({ error: 'Email already verified' });

    /**
     * The limit that is about the person receiving the mail, not the machine
     * asking.
     *
     * The route's per-IP ceiling stops one address flooding the service and does
     * nothing about the case that actually hurts somebody: an attacker naming a
     * stranger's address from enough machines to stay under it, which is a mail
     * bomb they cannot turn off. This one is counted against the account, so
     * where the requests come from does not matter.
     */
    const prepared = otp.prepareCode(user, 'email');
    if (!prepared.allowed) {
      auditLog(req, {
        userId: user.id, action: 'auth.email_code_throttled', entity: 'User', entityId: user.id,
        metadata: { reason: prepared.reason },
      });
      return throttled(res, prepared);
    }

    await user.update(prepared.fields);

    // Same reasoning as `register`: a resend that quietly fails is worse than
    // one that says so, because the parent goes on waiting for it.
    const emailDelivered = await sendVerificationEmail({ name: user.name, email, code: prepared.code });
    if (!emailDelivered) logger.error('Verification email was not delivered', { email });

    auditLog(req, { userId: user.id, action: 'auth.email_code_resent', entity: 'User', entityId: user.id });

    res.json({
      message: emailDelivered
        ? 'Verification code resent'
        : 'We could not deliver the verification email.',
      emailDelivered,
    });
  } catch (err) {
    next(err);
  }
};

const updateProfile = async (req, res, next) => {
  try {
    const { name, email } = req.body;
    if (!name && !email) return res.status(400).json({ error: 'Nothing to update' });

    const updates = {};
    if (name) updates.name = name.trim();

    /**
     * A new address is unproven, and has to be re-verified.
     *
     * This wrote the address straight through and left `emailVerified` true, so
     * an account could move to any address its owner had never demonstrated
     * control of while still counting as verified. Everything that matters then
     * follows the account there: the password-reset code, every alert about the
     * child, the receipts. A typo alone silently redirected all of it to a
     * stranger, and nothing in the flow ever asked the new address to prove
     * itself.
     *
     * Sessions are deliberately left alone. The caller stays signed in, which is
     * what makes this safe to fail: a mistyped address can be corrected from the
     * same screen, whereas signing them out would strand the account behind a
     * verification code sent somewhere they cannot read.
     */
    // Compared in the stored (normalised) form so re-saving your own address
    // with different capitalisation is a no-op rather than a clash with itself.
    const changingEmail = !!email && normalizeEmail(email) !== req.user.email;
    let verificationSent = false;
    // Held here because `updates.emailVerificationCode` is the *hash* the moment
    // it goes through the model — the digits exist only between this line and
    // the message that carries them.
    let issuedCode = null;

    if (changingEmail) {
      const existing = await User.findByEmail(email);
      if (existing) return res.status(409).json({ error: 'Email already in use' });

      // Rate limited like any other code, and for the sharper version of the
      // same reason: this one is aimed at an address chosen by whoever holds the
      // session, so without a limit a stolen session is a mail cannon.
      const prepared = otp.prepareCode(req.user, 'email');
      if (!prepared.allowed) return throttled(res, prepared);

      issuedCode = prepared.code;
      updates.email = email;
      updates.emailVerified = false;
      Object.assign(updates, prepared.fields);
    }

    await req.user.update(updates);

    if (changingEmail) {
      verificationSent = await sendVerificationEmail({
        name: req.user.name,
        email: req.user.email,
        code: issuedCode,
      });
      if (!verificationSent) logger.error('Verification email was not delivered', { email: req.user.email });
      auditLog(req, {
        userId: req.user.id,
        action: 'auth.email_changed',
        entity: 'User',
        entityId: req.user.id,
        metadata: { email: req.user.email },
      });
    }

    auditLog(req, { userId: req.user.id, action: 'auth.profile_updated', entity: 'User', entityId: req.user.id });
    res.json({
      ...serializeUser(req.user),
      // The client needs to know the account can no longer sign in until the new
      // address is confirmed, and whether the code actually left the building.
      emailVerificationRequired: changingEmail,
      emailDelivered: changingEmail ? verificationSent : undefined,
    });
  } catch (err) {
    next(err);
  }
};

const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    /**
     * An account signed up through Google or a phone number has no password, so
     * there is nothing for `currentPassword` to be checked against and demanding
     * it made this endpoint unreachable for them: the settings screen showed the
     * form, and every submission answered "Current password is incorrect".
     *
     * Setting the first one is allowed on the strength of the session alone,
     * which is the same standard every other account-changing route here holds.
     * It is also the point: it gives an account that could only ever be reached
     * through one identity provider a second way in, and the confirmation email
     * below still goes out, so a session someone else is holding cannot do this
     * quietly.
     */
    const settingFirstPassword = !req.user.passwordHash;

    if (!newPassword || (!settingFirstPassword && !currentPassword)) {
      return res.status(400).json({ error: 'Both passwords required' });
    }

    const weak = passwordProblem(newPassword);
    if (weak) return res.status(400).json({ error: weak });

    if (!settingFirstPassword && !(await req.user.comparePassword(currentPassword))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    await req.user.update({ passwordHash: newPassword });

    /**
     * Every other session goes, for the same reason `resetPassword` drops all of
     * them: changing a password is what someone does when they think it is
     * known, and a change that leaves the attacker's session live achieves
     * nothing. This kept every other session — the old password stopped working
     * while every token minted with it kept full access until it expired.
     *
     * The caller's own session survives, so the tab doing the change stays
     * signed in and no token has to be swapped client-side.
     */
    const revokedCount = await revokeOtherSessions(req.user.id, req.sessionId, req.app.get('io'));

    /**
     * The account holder is told, because they are the one who needs to know
     * when they did not do it.
     *
     * Changing a password is a takeover's last step as often as it is a hygiene
     * measure, and until now it was completely silent: an attacker with a live
     * session could change the password, evict the real owner, and the only
     * signal the owner ever got was a login that stopped working. This mail is
     * what turns that into something they can act on while a reset code can
     * still be sent to an address they control.
     */
    track(
      sendPasswordChangedEmail({ name: req.user.name, email: req.user.email, when: new Date() }).then(
        (delivered) => {
          if (!delivered) logger.error('Password-changed notification was not delivered', { userId: req.user.id });
        }
      )
    );

    auditLog(req, {
      userId: req.user.id,
      action: 'auth.password_changed',
      entity: 'User',
      entityId: req.user.id,
      metadata: { otherSessionsRevoked: revokedCount },
    });
    res.json({
      message: revokedCount
        ? `Password updated. You have been signed out on ${revokedCount} other ${revokedCount === 1 ? 'device' : 'devices'}.`
        : 'Password updated',
      otherSessionsRevoked: revokedCount,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Sign in with Google — registration and login through one endpoint.
 *
 * The browser (or the Android app) obtains an ID token from Google and posts it
 * here. Nothing about the caller is trusted: the token is a JWT signed by
 * Google, and `verifyIdToken` checks the signature against Google's published
 * keys, the issuer, the expiry, and the audience against the client IDs this
 * deployment was configured with. A token minted for a different application
 * therefore cannot be replayed here — which is the whole reason `audiences` is
 * required rather than defaulted to "anything".
 */
let googleClient = null;
const googleAuth = async (req, res, next) => {
  try {
    const audience = env.googleSignIn.audiences;
    if (!audience.length) {
      // Reported as unavailable rather than as a failure: nothing is broken, the
      // deployment simply has no OAuth client. The sign-in button asks this of
      // GET /api/auth/providers and hides itself, so reaching here means a
      // client that ignored the answer.
      return res.status(503).json({ error: 'Google sign-in is not configured for this deployment' });
    }

    const credential = req.body?.credential;
    if (!credential) return res.status(400).json({ error: 'Google credential required' });

    googleClient = googleClient || new OAuth2Client();

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: credential, audience });
      payload = ticket.getPayload();
    } catch (err) {
      // Deliberately vague to the caller, specific in the log: a rejected token
      // is either an attack or a misconfigured audience, and only one of those
      // deserves the detail.
      logger.warn('Google ID token rejected', { error: err.message });
      return res.status(401).json({ error: 'Google sign-in failed' });
    }

    const email = normalizeEmail(payload.email);

    /**
     * The check that stops this being an account-takeover endpoint.
     *
     * Below, an existing Parentix account is linked to a Google identity that
     * presents the same address. If Google had not verified that address, anyone
     * could create a Google account claiming a victim's email and walk straight
     * into their family's data. Google sets `email_verified` false exactly when
     * it has not proved ownership, so it is refused rather than linked.
     */
    if (!email || payload.email_verified !== true) {
      logger.warn('Google sign-in refused: address not verified by Google', { email });
      return res.status(401).json({ error: 'Your Google account has no verified email address' });
    }

    // Linked accounts are found by subject, which the account owner cannot
    // change. Only a first-time sign-in falls through to matching on address.
    let user = await User.findOne({ where: { googleId: payload.sub } });
    let created = false;

    if (!user) {
      user = await User.findByEmail(email);

      if (user) {
        if (user.googleId && user.googleId !== payload.sub) {
          // Two Google identities claiming one Parentix account. Should not
          // happen — `sub` is stable — so it is refused rather than reassigned.
          logger.error('Google sign-in refused: account already linked to another Google identity', { email });
          return res.status(409).json({ error: 'This account is linked to a different Google account' });
        }
        // Google has just proved control of the address, so an account that was
        // stuck unverified is verified by this.
        await user.update({ googleId: payload.sub, emailVerified: true });
        auditLog(req, { userId: user.id, action: 'auth.google_linked', entity: 'User', entityId: user.id, metadata: { email } });
      } else {
        user = await User.create({
          name: payload.name || email.split('@')[0],
          email,
          // No password, and no placeholder standing in for one: a random
          // unknown hash would look like a credential that could be guessed,
          // and would let the account be "reset" into by anyone who requested a
          // link. The column is nullable for exactly this case.
          passwordHash: null,
          googleId: payload.sub,
          emailVerified: true,
          trialEndsAt: await trialEndsAtFromNow(),
        });
        created = true;
        auditLog(req, { userId: user.id, action: 'auth.register_google', entity: 'User', entityId: user.id, metadata: { email } });
        track(sendWelcomeEmail({ name: user.name, email }));
        track(sendAdminRegistrationNotification({ name: user.name, email }));
      }
    }

    // From here the rules are the password flow's rules. Signing in with Google
    // must not be a way around a deactivation or a second factor.
    if (!user.isActive) {
      auditLog(req, { userId: user.id, action: 'auth.login_blocked_inactive', metadata: { email } });
      return res.status(403).json({ error: 'This account has been deactivated. Contact an administrator.' });
    }

    /**
     * Maintenance mode refuses the session, not the credential.
     *
     * Placed after the account has proved itself and before `createSession`, so
     * the answer does not depend on whether the password was right — and so
     * nothing about who exists leaks through it. Staff pass straight through
     * (see utils/maintenance.js): they are the ones who turn it off.
     */
    if (await blocksSignIn(user)) {
      auditLog(req, { userId: user.id, action: 'auth.login_blocked_maintenance', entity: 'User', entityId: user.id });
      return res.status(503).json({ error: MAINTENANCE_MESSAGE, maintenance: true });
    }

    if (user.mfaEnabled) {
      const preAuthToken = signPreAuthToken(user.id);
      auditLog(req, { userId: user.id, action: 'auth.mfa_challenge', entity: 'User', entityId: user.id });
      return res.json({ mfaRequired: true, preAuthToken });
    }

    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      await user.update({ failedLoginAttempts: 0, lockedUntil: null });
    }

    const { token, session } = await createSession(req, user.id);
    await user.update({ lastLoginAt: new Date() });
    auditLog(req, { userId: user.id, action: 'auth.login', entity: 'User', entityId: user.id, metadata: { via: 'google' } });
    track(notifyNewSignIn(req, user, session.id));

    res.status(created ? 201 : 200).json({ token, user: serializeUser(user), created });
  } catch (err) {
    next(err);
  }
};

/**
 * What sign-in methods this deployment actually offers, so the UI can ask.
 *
 * `phone` is reported for the same reason `google` is: the sign-in screen used
 * to offer a Phone tab unconditionally, and a deployment with no SMS
 * credentials answers `requestPhoneCode` with a perfectly successful 200 and
 * `smsDelivered: false` — so the parent was walked to a code screen to wait for
 * a message that was never going to arrive. This is the codebase's existing rule
 * about controls that promise what the platform cannot do, applied to the very
 * first screen anyone sees.
 *
 * `canVerifyByPhone` rather than `isEnabled`, because the rule is about whether
 * the flow can be *finished*, not whether an SMS leaves the building. In
 * development the code comes back in the response instead, which is a way to
 * finish it; the tab was previously hidden there too, which meant the only
 * environment anyone could develop against was the one that hid the feature.
 */
const authProviders = async (req, res, next) => {
  try {
    res.json({
      password: true,
      google: env.googleSignIn.audiences.length > 0,
      phone: canVerifyByPhone(),
      /**
       * So the sign-in screen can say so before anyone types a password.
       *
       * The console's copy promises "the apps show a maintenance notice", and
       * this is the only unauthenticated call the sign-in page already makes —
       * without it the notice could only appear after a failed attempt, which is
       * the opposite of a notice.
       */
      maintenance: await maintenanceModeOn(),

      /**
       * Whether this deployment can actually take money, by the same rule as
       * `phone` above — a control must not promise what the platform cannot do.
       *
       * With no STRIPE_SECRET_KEY every checkout answers 503, and the plan
       * screen offered "Upgrade to Premium" regardless. That button is worst
       * exactly where it matters most: an expired trial drops the account to
       * `free`, featureGate starts refusing devices, and the notice tells the
       * parent to upgrade to keep monitoring their family — pointing them at
       * the one button in the product guaranteed not to work.
       *
       * Reported unauthenticated alongside the rest because it describes the
       * deployment, not the account, and it discloses nothing a failed checkout
       * would not. It flips back on its own the moment a key is configured.
       */
      billing: !!env.stripe.secretKey,
    });
  } catch (err) {
    next(err);
  }
};

/* ── Forgotten password ───────────────────────────────────────────────────────
 *
 * Three steps, and a code rather than a link: ask for one, present it, choose a
 * new password.
 *
 * The middle step is what the link used to be. `verify-reset-code` exchanges six
 * digits for a random single-use ticket, and `reset-password` takes that ticket
 * — so the endpoint that actually changes the password is unchanged, and what
 * changed is only how a ticket comes into existence. That split matters: it
 * means the secret that travels through somebody's inbox is short-lived and
 * attempt-limited, while the secret that authorises the change never leaves the
 * two requests it lives between.
 *
 * The same three properties hold across all of it. Nothing here says whether an
 * address has an account. Nothing here signs anybody in — a reset ends at the
 * sign-in screen, which then applies every gate it always did. And every step
 * lands in the audit log, because this is the flow somebody walks when they have
 * already lost control of something.
 */

/** How long the ticket minted by `verify-reset-code` is good for. */
const RESET_TOKEN_EXPIRES_MS = 15 * 60 * 1000;

/**
 * Identical for an address with an account and one without — including when the
 * account exists but has asked too often, which is the case that is easy to get
 * wrong. A 429 there would answer a question the 200 exists to refuse.
 */
const RESET_REQUESTED_MESSAGE = 'If an account exists for that email, we have sent a 6-digit code';

const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await User.findByEmail(email);

    if (user) {
      const prepared = otp.prepareCode(user, 'reset');

      if (!prepared.allowed) {
        /**
         * Refused silently, and recorded.
         *
         * The caller is told nothing, because the cooldown is a fact about an
         * account and telling them would be the enumeration oracle this whole
         * endpoint is shaped around avoiding. The operator is told everything,
         * because a stream of these is somebody being mail-bombed.
         */
        auditLog(req, {
          userId: user.id, action: 'auth.password_reset_throttled', entity: 'User', entityId: user.id,
          metadata: { reason: prepared.reason },
        });
        return res.json({ message: RESET_REQUESTED_MESSAGE });
      }

      /**
       * Any ticket already outstanding dies here.
       *
       * Asking for a new code is what somebody does when the last one went
       * astray, and a half-finished reset that stays live is a key to the
       * account sitting in whatever went wrong the first time.
       */
      await user.update({ ...prepared.fields, passwordResetToken: null, passwordResetExpires: null });

      /**
       * Awaited and its result logged, but never reported to the caller.
       *
       * `mailer.send` reports failure by resolving false rather than throwing,
       * so a code that never left the server produces no error of its own — and
       * this is the flow people use when they are already locked out, so it is
       * the failure operators most need to see. The response stays identical
       * either way: saying "we could not send it" would confirm the address has
       * an account.
       */
      const delivered = await sendPasswordResetCodeEmail({ name: user.name, email, code: prepared.code });
      if (!delivered) logger.error('Password reset email was not delivered', { email });

      auditLog(req, { userId: user.id, action: 'auth.password_reset_requested', entity: 'User', entityId: user.id });
    }

    res.json({ message: RESET_REQUESTED_MESSAGE });
  } catch (err) {
    next(err);
  }
};

/**
 * Step two: six digits in, a single-use ticket out.
 *
 * Every refusal is the same sentence — an address with no account, a wrong code,
 * an expired one, and a code that has been guessed at too many times all answer
 * `Invalid or expired code`. Anything finer would turn this into the account
 * oracle that `forgotPassword` above is careful not to be.
 *
 * A wrong code is deliberately *not* counted against `failedLoginAttempts`. Every
 * other code path on this service locks the account after five, and that is
 * right where the code is a way *in*; here it would let anyone who knows an
 * address lock its owner out of the one flow that exists to get them back in.
 * `otp.checkCode` still burns the code after five wrong guesses, so the guessing
 * is bounded — it just costs the attacker a code rather than costing the owner
 * their recovery path.
 */
const verifyResetCode = async (req, res, next) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code required' });

    const invalid = () => res.status(400).json({ error: 'Invalid or expired code' });

    const user = await User.findByEmail(email);
    if (!user) return invalid();

    const checked = otp.checkCode(user, 'reset', code);
    if (!checked.ok) {
      await user.update(checked.fields);
      auditLog(req, {
        userId: user.id, action: 'auth.password_reset_code_failed', entity: 'User', entityId: user.id,
        metadata: { reason: checked.reason },
      });
      return invalid();
    }

    const token = crypto.randomBytes(32).toString('hex');
    await user.update({
      ...checked.fields,
      passwordResetToken: token,
      passwordResetExpires: new Date(Date.now() + RESET_TOKEN_EXPIRES_MS),
    });

    auditLog(req, { userId: user.id, action: 'auth.password_reset_code_verified', entity: 'User', entityId: user.id });

    // Returned in the body rather than mailed, because the address has just been
    // proved by the code that arrived at it. It is single use, it expires in
    // fifteen minutes, and it authorises exactly one thing.
    res.json({ resetToken: token, expiresIn: Math.floor(RESET_TOKEN_EXPIRES_MS / 1000) });
  } catch (err) {
    next(err);
  }
};

const resetPassword = async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required' });

    const weak = passwordProblem(newPassword);
    if (weak) return res.status(400).json({ error: weak });

    const user = await User.findOne({ where: { passwordResetToken: token } });
    if (!user || !user.passwordResetExpires || new Date() > new Date(user.passwordResetExpires)) {
      return res.status(400).json({ error: 'Invalid or expired reset request' });
    }

    await user.update({
      passwordHash: newPassword,
      passwordResetToken: null,
      passwordResetExpires: null,
      /**
       * The code goes too, not just the ticket it bought.
       *
       * `verify-reset-code` already consumes it, so this is belt and braces for
       * any future path that mints a ticket some other way — a code left alive
       * after the password it guards has already been changed is a second key to
       * a door that has just been re-locked.
       */
      passwordResetCode: null,
      passwordResetCodeExpires: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
    });

    // A reset is the recovery path after a suspected compromise — every existing
    // session has to go, not just the one doing the reset.
    await revokeAllSessions(user.id, req.app.get('io'));

    // Confirms the reset to the address that asked for it. A reset that somebody
    // else drove is only visible to the owner through this.
    track(
      sendPasswordChangedEmail({ name: user.name, email: user.email, when: new Date(), viaReset: true }).then(
        (delivered) => {
          if (!delivered) logger.error('Password-reset confirmation was not delivered', { userId: user.id });
        }
      )
    );

    auditLog(req, { userId: user.id, action: 'auth.password_reset', entity: 'User', entityId: user.id });
    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    next(err);
  }
};

const getNotificationPrefs = async (req, res, next) => {
  try {
    const prefs = req.user.notificationPrefs ? JSON.parse(req.user.notificationPrefs) : {};
    // One entry per alert type the platform can actually raise. `blocked_app_attempt`
    // is off by default because a determined child trips it repeatedly, and an
    // inbox full of it is how parents learn to ignore the others.
    const defaults = {
      emailAlerts: true,
      emailHighOnly: true,
      // Push is on by default but only reaches a browser the parent has
      // explicitly subscribed, so this cannot notify anyone who has not opted in.
      pushAlerts: true,
      alertTypes: {
        emergency_button: true,
        cyberbullying: true,
        left_safe_zone: true,
        entered_safe_zone: false,
        safety_pattern: true,
        screen_time_exceeded: true,
        blocked_app_attempt: false,
        // Raised once the device holds an approved-contact list and someone not
        // on it tries to reach the child.
        unknown_contact: true,
      },
    };
    res.json({ ...defaults, ...prefs, alertTypes: { ...defaults.alertTypes, ...(prefs.alertTypes || {}) } });
  } catch (err) {
    next(err);
  }
};

const updateNotificationPrefs = async (req, res, next) => {
  try {
    const current = req.user.notificationPrefs ? JSON.parse(req.user.notificationPrefs) : {};
    const updated = { ...current, ...req.body };
    if (req.body.alertTypes) updated.alertTypes = { ...(current.alertTypes || {}), ...req.body.alertTypes };
    await req.user.update({ notificationPrefs: JSON.stringify(updated) });
    res.json(updated);
  } catch (err) {
    next(err);
  }
};

/* ── Phone sign-in ────────────────────────────────────────────────────────────
 *
 * Passwordless, and deliberately so: a number that can receive a code is the
 * whole of the proof, exactly as it is for every other app that offers this. The
 * account it creates has no password and no address, which is why `email` and
 * `password_hash` are both nullable — see migration 0012.
 *
 * Two endpoints, mirroring the email pair: request a code, then present it.
 * `verifyPhoneCode` ends in the same three lines as `login` — MFA challenge if
 * enabled, otherwise a session — so a phone account is not a second class of
 * session with its own rules about revocation or two-factor.
 */

const requestPhoneCode = async (req, res, next) => {
  try {
    /**
     * The same 503 `googleAuth` gives, and for the stronger reason.
     *
     * `/auth/providers` already reports `phone: canVerifyByPhone()` and the
     * sign-in screen hides the tab on it — but the endpoint did not ask, so a
     * deployment that advertises no phone sign-in still answered `mode:
     * "register"` by *creating a user row* and granting it a trial, then
     * discovering it had no way to send the code. An account nobody can sign in
     * to, holding a number nobody proved, made by a feature the deployment says
     * it does not have. Advertising a capability and enforcing it have to be the
     * same predicate, or the quieter of the two is decorative.
     */
    if (!canVerifyByPhone()) {
      return res.status(503).json({ error: 'Phone sign-in is not configured for this deployment' });
    }

    const { name, mode } = req.body;
    const phone = normalizePhone(req.body.phone);
    if (!phone) {
      return res.status(400).json({ error: 'Enter a valid phone number, including its country code' });
    }

    let user = await User.findByPhone(phone);
    const registering = mode === 'register';

    /**
     * Decided before the row is touched, so a throttled request cannot leave a
     * user behind as a side effect.
     *
     * An account that does not exist yet has no send history and so is always
     * allowed its first code — the limit engages from the second request
     * onwards, which is the one that can be abused. This matters more here than
     * on the email flows: every call that gets past this point spends money at
     * the SMS provider and lands on a real handset, and the route's per-IP
     * ceiling does nothing about a number being texted from many machines.
     */
    const prepared = otp.prepareCode(user || {}, 'phone');
    if (!prepared.allowed) {
      if (user) {
        auditLog(req, {
          userId: user.id, action: 'auth.phone_code_throttled', entity: 'User', entityId: user.id,
          metadata: { reason: prepared.reason },
        });
      }
      return throttled(res, prepared);
    }

    if (registering) {
      // Only a *verified* number is taken. An abandoned signup leaves a row
      // holding a number its owner never proved, and refusing to let the real
      // owner claim it later would hand anyone a way to permanently deny an
      // account to any number they can type.
      if (user?.phoneVerified) {
        return res.status(409).json({ error: 'That number is already registered. Sign in instead.' });
      }
      if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
      if (!user) {
        user = await User.create({
          name: name.trim(), phone, trialEndsAt: await trialEndsAtFromNow(), ...prepared.fields,
        });
      } else {
        // Resuming an abandoned signup. Backfilled only when absent, which both
        // heals a row created before the trial was granted here and stops the
        // seven days being farmed by re-requesting a code forever.
        await user.update({
          name: name.trim(),
          ...(user.trialEndsAt ? {} : { trialEndsAt: await trialEndsAtFromNow() }),
          ...prepared.fields,
        });
      }
    } else if (!user?.phoneVerified) {
      /*
       * This confirms whether a number has an account, which sign-in by email
       * also does via its 409 on register. The alternative — always answering
       * "code sent" — reads as neutral and behaves terribly: someone who mistyped
       * a digit waits for a message that was never going to arrive, with nothing
       * to tell them why. The rate limiter on this route is what makes bulk
       * enumeration impractical, rather than the wording of this line.
       */
      return res.status(404).json({ error: 'No account found for that number. Create one instead.' });
    } else {
      // Signing in: the row already exists, so only the code columns move.
      await user.update(prepared.fields);
    }

    const code = prepared.code;
    const smsDelivered = await sendVerificationSms({ phone, code });
    if (!smsDelivered) logger.error('Phone verification SMS was not delivered', { phone: maskPhone(phone) });

    auditLog(req, {
      userId: user.id,
      action: registering ? 'auth.phone_code_requested_register' : 'auth.phone_code_requested_login',
      entity: 'User',
      entityId: user.id,
    });

    res.json({
      // Masked, never echoed whole: the number was supplied to receive one
      // message, and a response body ends up in logs and error trackers.
      phone: maskPhone(phone),
      message: smsDelivered
        ? 'We sent a 6-digit code to your phone.'
        : env.sms.echoCode
          ? 'SMS is not configured, so the code is shown here instead. This only happens outside production.'
          : 'Your code could not be sent. Check the SMS settings for this deployment.',
      smsDelivered,
      /**
       * Development only, and never both: once a provider is configured
       * `echoCode` is false and the code goes to the phone. See `sms.echoCode`
       * for why this is off in production by construction rather than by
       * remembering to unset it.
       */
      ...(env.sms.echoCode && !smsDelivered ? { devCode: code } : {}),
    });
  } catch (err) {
    next(err);
  }
};

const verifyPhoneCode = async (req, res, next) => {
  try {
    const { code } = req.body;
    const phone = normalizePhone(req.body.phone);
    if (!phone || !code) return res.status(400).json({ error: 'Phone number and code required' });

    const user = await User.findByPhone(phone);
    if (!user) return res.status(400).json({ error: 'Invalid or expired code' });

    if (user.lockedUntil && new Date() < new Date(user.lockedUntil)) {
      auditLog(req, { userId: user.id, action: 'auth.login_blocked_locked' });
      return res.status(423).json({ error: 'Account temporarily locked due to repeated failed logins. Try again later.' });
    }

    const checked = otp.checkCode(user, 'phone', code);

    if (!checked.ok) {
      // Counted against the same lockout the password path uses, on top of the
      // per-code budget `checkCode` keeps. Six digits is a million
      // possibilities, and the per-route limiter caps a single IP — this is what
      // caps the account no matter where the guesses come from.
      const attempts = user.failedLoginAttempts + 1;
      const updates = { ...checked.fields, failedLoginAttempts: attempts };
      if (attempts >= MAX_LOGIN_ATTEMPTS) {
        updates.failedLoginAttempts = 0;
        updates.lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
      }
      await user.update(updates);
      auditLog(req, {
        userId: user.id, action: 'auth.phone_code_failed', entity: 'User', entityId: user.id,
        metadata: { reason: checked.reason },
      });
      return res.status(400).json({ error: 'Invalid or expired code' });
    }

    const firstVerification = !user.phoneVerified;
    await user.update({
      ...checked.fields,
      phoneVerified: true,
      failedLoginAttempts: 0,
      lockedUntil: null,
    });

    if (firstVerification) {
      auditLog(req, { userId: user.id, action: 'auth.phone_verified', entity: 'User', entityId: user.id });
    }

    // Same gate as `login` and `verifyEmail`. Phone sign-in is a full sign-in,
    // so a blocked account must not complete it just because it holds the SMS.
    if (!user.isActive) {
      auditLog(req, { userId: user.id, action: 'auth.login_blocked_inactive', metadata: { phone: maskPhone(phone) } });
      return res.status(403).json({ error: 'This account has been deactivated. Contact an administrator.' });
    }

    /**
     * Maintenance mode refuses the session, not the credential.
     *
     * Placed after the account has proved itself and before `createSession`, so
     * the answer does not depend on whether the password was right — and so
     * nothing about who exists leaks through it. Staff pass straight through
     * (see utils/maintenance.js): they are the ones who turn it off.
     */
    if (await blocksSignIn(user)) {
      auditLog(req, { userId: user.id, action: 'auth.login_blocked_maintenance', entity: 'User', entityId: user.id });
      return res.status(503).json({ error: MAINTENANCE_MESSAGE, maintenance: true });
    }

    // The tail of `login`, deliberately identical: an account with MFA on gets a
    // challenge rather than a session, whichever factor got it this far.
    if (user.mfaEnabled) {
      const preAuthToken = signPreAuthToken(user.id);
      auditLog(req, { userId: user.id, action: 'auth.login_mfa_required', entity: 'User', entityId: user.id });
      return res.json({ mfaRequired: true, preAuthToken });
    }

    const { token, session } = await createSession(req, user.id);
    await user.update({ lastLoginAt: new Date() });
    auditLog(req, { userId: user.id, action: 'auth.login', entity: 'User', entityId: user.id });
    track(notifyNewSignIn(req, user, session.id));
    res.json({ token, user: serializeUser(user) });
  } catch (err) {
    next(err);
  }
};

/**
 * The sessions this account currently has, newest first.
 *
 * The platform emails an account holder when their account is opened from a
 * device it has not seen before, and until now that message had no follow-up:
 * there was nowhere in the product to see the sessions, and nothing to end one.
 * The only lever was changing the password, which signs out everything —
 * including the phone the parent is reading the email on. Staff had this screen
 * in the admin console; the person whose account it is did not.
 */
const listSessions = async (req, res, next) => {
  try {
    const sessions = await Session.findAll({
      where: { userId: req.user.id, revoked: false },
      order: [['lastActiveAt', 'DESC']],
      attributes: ['id', 'ipAddress', 'userAgent', 'lastActiveAt', 'createdAt'],
    });

    res.json(
      sessions.map((s) => ({
        id: s.id,
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
        lastActiveAt: s.lastActiveAt,
        createdAt: s.createdAt,
        // Which row not to offer a "sign out" button for. Ending the session
        // making the request works, but it reads as a bug rather than a logout.
        current: s.id === req.sessionId,
      }))
    );
  } catch (err) {
    next(err);
  }
};

/** End one other session. The current one is what `POST /auth/logout` is for. */
const revokeOneSession = async (req, res, next) => {
  try {
    // A malformed id is "not found", not a database error — see utils/ids.js.
    const session = isUuid(req.params.id)
      ? await Session.findOne({ where: { id: req.params.id, userId: req.user.id } })
      : null;
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (session.id === req.sessionId) {
      return res.status(400).json({ error: 'That is this session — use sign out instead.' });
    }

    await revokeSession(session.id, req.app.get('io'));
    auditLog(req, {
      userId: req.user.id, action: 'auth.session_revoked', entity: 'Session', entityId: session.id,
    });
    res.json({ message: 'That device has been signed out.' });
  } catch (err) {
    next(err);
  }
};

/** End every session except this one. */
const revokeOtherSessionsForUser = async (req, res, next) => {
  try {
    const revoked = await revokeOtherSessions(req.user.id, req.sessionId, req.app.get('io'));
    auditLog(req, { userId: req.user.id, action: 'auth.sessions_revoked_others', metadata: { revoked } });
    res.json({ revoked, message: `Signed out ${revoked} other device${revoked === 1 ? '' : 's'}.` });
  } catch (err) {
    next(err);
  }
};

/**
 * Close the account and erase what it holds.
 *
 * There was no way to do this at all — not in the product, not in the API. For a
 * service that stores a child's location history, contacts and browsing, that is
 * a hole in the law (the right to erasure) before it is a missing feature, and
 * Google Play requires an in-app route to it for any app that lets you create an
 * account, which the family app does.
 *
 * Three things make this harder than a `DELETE`:
 *
 * **It is proved, not just authenticated.** A live session is not enough — a
 * borrowed laptop is a live session. The password is re-entered here for the
 * same reason it is re-entered to change itself. An account with no password
 * (Google, phone) has none to check, so it types the word instead; what matters
 * is that the step cannot be reached by accident.
 *
 * **Billing is stopped first.** Deleting the rows while the subscription renews
 * charges a card belonging to someone with no login left to stop it. If Stripe
 * cannot be reached, nothing is deleted and the caller is told to try again —
 * an account that still exists is recoverable, a silently-billed deleted one is
 * not.
 *
 * **The child's data goes too.** It is the parent's account that gathered it and
 * the parent's account that consents to it. Everything hanging off the children
 * is removed in one transaction, so a failure half way cannot leave a device
 * still uploading a dead child's location.
 */
const deleteAccount = async (req, res, next) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ error: 'Account not found' });

    if (user.passwordHash) {
      const { password } = req.body;
      if (!password || !(await user.comparePassword(password))) {
        auditLog(req, { userId: user.id, action: 'auth.account_delete_refused', metadata: { reason: 'password' } });
        return res.status(401).json({ error: 'That password is not correct.' });
      }
    } else if (String(req.body.confirm || '').trim().toUpperCase() !== 'DELETE') {
      return res.status(400).json({ error: 'Type DELETE to confirm.' });
    }

    const cancelled = await cancelSubscription(user.stripeSubscriptionId);
    if (!cancelled.ok) {
      return res.status(503).json({
        error: 'We could not cancel your subscription just now, so nothing has been deleted. Please try again in a few minutes.',
      });
    }

    const removed = await eraseAccount(user, { io: req.app.get('io') });

    /**
     * The audit row outlives the account deliberately, and carries no more than
     * the fact. A deletion that leaves no trace is indistinguishable from a
     * database fault, which is precisely the question an operator asks when a
     * customer says their account vanished — so the record stays, and the
     * personal data it would otherwise repeat (the address, the children's
     * names) does not.
     */
    auditLog(req, {
      userId: null,
      action: 'auth.account_deleted',
      entity: 'User',
      entityId: user.id,
      metadata: removed,
    });

    res.json({ message: 'Your account and everything in it has been deleted.' });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  register, login, me, logout, verifyEmail, resendCode, updateProfile, changePassword,
  googleAuth, authProviders, requestPhoneCode, verifyPhoneCode,
  forgotPassword, verifyResetCode, resetPassword, getNotificationPrefs, updateNotificationPrefs,
  listSessions, revokeOneSession, revokeOtherSessionsForUser, deleteAccount,
};
