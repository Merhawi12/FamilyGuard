const { getSetting } = require('./settings');
const { isStaffRole } = require('../config/roles');
const logger = require('./logger');

/**
 * Maintenance mode — the console's toggle, made real.
 *
 * The switch has existed on the Settings screen since it shipped, alongside a
 * banner stating plainly: "While this is on, parents cannot sign in and the apps
 * show a maintenance notice. Sessions already open are not affected." It wrote a
 * row to `system_settings` and nothing on the platform ever read it, so an
 * operator turning it on to take the service down for a migration got a
 * reassuring warning panel and a service that carried on signing people in.
 *
 * What is implemented here is exactly what that copy promises, and no more:
 *
 *   - **New sign-ins are refused.** Every path that mints a session asks first.
 *   - **Sessions already open keep working.** `authenticate` is deliberately not
 *     touched: cutting live sessions is what `maintenanceMode` does *not* claim
 *     to do, and a parent mid-way through checking their child's location should
 *     not be dropped by an operator flipping a switch.
 *   - **Staff are never blocked.** They are the people who turn it back off, and
 *     an admin who cannot sign in to a platform in maintenance mode has locked
 *     themselves out of the only control that ends it.
 */
const MAINTENANCE_MESSAGE =
  'Parentix is down for maintenance right now. Please try again shortly.';

/**
 * Whether the platform is in maintenance mode.
 *
 * A read failure answers "no", deliberately. This is consulted on the sign-in
 * path, so a settings table that is briefly unreachable must not become a
 * platform-wide lockout — the failure that would be hardest to diagnose and the
 * one with the worst consequence. It is logged instead.
 *
 * The comparison tolerates both shapes the value comes back in: a `json` column
 * is parsed to a boolean by Postgres, and older rows written before this was a
 * json column can still be the string.
 */
const maintenanceModeOn = async () => {
  try {
    const value = await getSetting('maintenanceMode', false);
    return value === true || value === 'true';
  } catch (err) {
    logger.error('Could not read the maintenance-mode setting — treating it as off', {
      error: err.message,
    });
    return false;
  }
};

/**
 * Whether this particular sign-in has to be refused.
 *
 * @param {{ role?: string }} user the account that has just proved itself
 * @returns {Promise<boolean>}
 */
const blocksSignIn = async (user) => {
  if (isStaffRole(user?.role)) return false;
  return maintenanceModeOn();
};

module.exports = { maintenanceModeOn, blocksSignIn, MAINTENANCE_MESSAGE };
