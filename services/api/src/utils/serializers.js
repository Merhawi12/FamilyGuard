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
    // An account created from a phone number has no address, and one created
    // from an address has no number. The client shows whichever identifier the
    // account actually has, so both ship and either may be null.
    phone: user.phone || null,
    phoneVerified: !!user.phoneVerified,
    /**
     * Shipped so the client can say so. Changing the address on the profile
     * screen clears this and re-sends a code, and without it here the app had no
     * way to tell the parent that their account can no longer sign in until the
     * new address is confirmed.
     */
    emailVerified: !!user.emailVerified,
    role: user.role,
    plan: user.plan,
    trialEndsAt,
    trialExpired,
    mfaEnabled: user.mfaEnabled,
    /**
     * Whether this account has a password at all.
     *
     * An account created through Google or a phone number has none, and the
     * settings screen showed it the ordinary "Change password" form anyway —
     * three fields whose only possible outcome was "Current password is
     * incorrect", because there was nothing to compare against. The same
     * question decides whether closing the account asks for a password or for a
     * typed confirmation. It is a boolean about the account, not the secret.
     */
    hasPassword: !!user.passwordHash,
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
