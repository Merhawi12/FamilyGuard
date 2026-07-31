/**
 * The only shape of a user that ever reaches a client. Keeping it in one place
 * stops password hashes, MFA secrets and reset tokens leaking through a new
 * endpoint that forgot to pick fields.
 */
const { isStaffRole, defaultPermissionsFor } = require('../config/roles');

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
    /**
     * The console hides screens the account cannot use. This is a convenience
     * only — every endpoint still checks server-side.
     *
     * Falls back to the role defaults so an account provisioned before the
     * permissions column was populated is not left with an empty console.
     */
    permissions: isStaffRole(user.role)
      ? (Array.isArray(user.permissions) && user.permissions.length
        ? user.permissions
        : defaultPermissionsFor(user.role))
      : [],
  };
};

module.exports = { serializeUser };
