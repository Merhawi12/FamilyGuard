/**
 * Why a device token was refused, in a form the child app can act on.
 *
 * The REST middleware and the Socket.IO handshake both walk the same chain —
 * device → child → parent — and both used to answer "Device revoked" to every
 * failure along it. That single message is why a phone whose device had been
 * deleted behaved exactly like one whose parent was temporarily blocked: it
 * carried on holding a token that could never work again, showing itself as
 * linked, and enforcing rules nobody could change.
 *
 * The two outcomes need opposite handling on the device, so they get separate
 * codes and the two transports agree on the spelling:
 *
 *  - `device_unlinked`   permanent. The device row is gone (removed by the
 *                        parent, or removed along with its child). Nothing can
 *                        restore it; the phone should forget its credentials and
 *                        go back to the linking screen.
 *  - `account_suspended` temporary and not the child's doing. The parent's
 *                        account is blocked or the child profile is deactivated.
 *                        The phone should keep its token and keep retrying — a
 *                        wipe here would need a fresh code from an account that
 *                        currently cannot sign in to produce one.
 *
 * These strings are a contract with the child app (`src/services/link.js`) and
 * are matched literally there. Changing one means shipping a new APK.
 */
const DEVICE_UNLINKED = 'device_unlinked';
const ACCOUNT_SUSPENDED = 'account_suspended';

/**
 * Why the lock screen is up when a parent paused this one device.
 *
 * Not a member of the pair above, and the difference is the point: those two are
 * reasons a *token was refused*, and a device holding either one can do nothing
 * further. A blocked device authenticates perfectly well. It keeps syncing,
 * keeps reporting its battery and location, and keeps its socket open — which is
 * what makes the block reversible in one tap and what keeps a paused phone
 * visible on the parent's map. Only the screen is locked.
 *
 * Blocking by revoking the token was the obvious alternative and is a trap: the
 * phone would go dark while carrying on enforcing its last-known rules, so the
 * parent would see "blocked" on a device they had actually just lost sight of.
 *
 * This joins `daily_limit`, `bedtime` and `outside_schedule` as a lock reason in
 * the child app and the desktop agent. Both already treat an unrecognised
 * reason as "locked, no specific explanation", so an older build that has never
 * heard of this string still locks — it just words it generically.
 */
const BLOCKED_BY_PARENT = 'blocked_by_parent';

module.exports = { DEVICE_UNLINKED, ACCOUNT_SUSPENDED, BLOCKED_BY_PARENT };
