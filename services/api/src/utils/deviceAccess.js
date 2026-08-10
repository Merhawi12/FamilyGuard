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

module.exports = { DEVICE_UNLINKED, ACCOUNT_SUSPENDED };
