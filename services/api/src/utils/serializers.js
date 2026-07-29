/**
 * The only shape of a user that ever reaches a client. Keeping it in one place
 * stops password hashes, MFA secrets and reset tokens leaking through a new
 * endpoint that forgot to pick fields.
 */
const serializeUser = (user) => {
  const trialEndsAt = user.trialEndsAt ? new Date(user.trialEndsAt).toISOString() : null;
  const trialExpired = !!trialEndsAt && new Date() > new Date(trialEndsAt);

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    plan: user.plan,
    trialEndsAt,
    trialExpired,
    mfaEnabled: user.mfaEnabled,
  };
};

module.exports = { serializeUser };
