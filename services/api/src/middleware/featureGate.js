const { getSetting } = require('../utils/settings');
const { DEFAULT_PLAN_FEATURES, FEATURE_LABELS, TRIAL_PLAN, PLAN_LIMITS } = require('../config/plans');
const { isStaffRole } = require('../config/roles');

const trialIsActive = (user) => !!user.trialEndsAt && new Date() < new Date(user.trialEndsAt);

/**
 * Stripe subscription states in which the account is no longer entitled to what
 * it is nominally on.
 *
 * `subscriptionStatus` was written by five webhook handlers and read by nothing:
 * entitlements came from `user.plan` alone, and the only handler that ever
 * lowers `plan` is `customer.subscription.deleted`. So an account whose payments
 * had stopped kept full Premium — indefinitely — as long as Stripe did not
 * delete the subscription, which is exactly what Stripe does *not* do when the
 * account's dunning setting is "mark unpaid" or "pause" rather than "cancel".
 * The status was recorded, shown to nobody, and enforced nowhere.
 *
 * The three below are the states where Stripe has stopped trying:
 *
 *   unpaid              retries exhausted; the invoice is open and abandoned
 *   incomplete_expired  the first payment was never completed and has expired
 *   paused              collection deliberately stopped
 *
 * `past_due` is deliberately absent, and that is a policy choice worth stating:
 * Stripe is still retrying the card, most of those recover, and cutting a family
 * off from location and safety alerts over a card that expired yesterday is a
 * worse failure than a few days of unpaid service. They keep everything while
 * the retries run; if they end in cancellation the `deleted` webhook drops the
 * plan to free, and if they end in `unpaid` this does.
 *
 * `canceled` is absent for a different reason: it always arrives with
 * `customer.subscription.deleted`, which sets `plan` to `free` outright, so
 * naming it here would be describing a state this function never sees.
 */
const UNENTITLED_STATUSES = new Set(['unpaid', 'incomplete_expired', 'paused']);

/**
 * The plan whose entitlements apply to this user right now.
 *
 * Registration hands out a 7-day trial and the welcome email promises full
 * access during it, so an unexpired trial is entitled to the trial tier. Only a
 * `free` account is lifted — a paid plan is never rewritten, and once the trial
 * lapses the account falls back to `free` on its own.
 *
 * A paid plan whose subscription has stopped paying falls back to `free` as
 * well. It is only the *entitlement* that falls back: `user.plan` is left alone,
 * so the plan screen still says Premium and billing can still be repaired from
 * the customer portal, rather than the account silently looking as though it was
 * never a subscriber.
 */
const effectivePlan = (user) => {
  if (user.plan === 'free') return trialIsActive(user) ? TRIAL_PLAN : 'free';
  // Gated on there being a Stripe subscription at all, so this reads as exactly
  // what it means: *a subscription that has stopped paying*. An account put on a
  // plan by hand from the console has no `stripeSubscriptionId`, and a stale
  // status must not quietly cancel a grant staff have just made — see
  // `updatePlan` in adminController, which clears one that is left dangling.
  if (user.stripeSubscriptionId && UNENTITLED_STATUSES.has(user.subscriptionStatus)) return 'free';
  return user.plan;
};

const requireFeature = (featureKey) => async (req, res, next) => {
  // Staff accounts are not on a plan — entitlements only mean anything for a parent.
  if (isStaffRole(req.user.role)) return next();

  try {
    const planFeatures = await getSetting('planFeatures', DEFAULT_PLAN_FEATURES);
    const allowed = planFeatures[effectivePlan(req.user)] || [];
    if (allowed.includes(featureKey)) return next();

    return res.status(403).json({
      error: `Upgrade required: ${FEATURE_LABELS[featureKey] || featureKey} is not included in your current plan`,
      feature: featureKey,
      upgradeRequired: true,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * How many devices this account may link in total, or null for unlimited.
 *
 * Reads through `effectivePlan`, so a trial gets the Premium allowance for the
 * seven days it lasts and drops to the Free one when it lapses — the same rule
 * that governs features, rather than a second one that could disagree.
 */
const deviceAllowance = (user) => {
  if (isStaffRole(user.role)) return null;
  const limits = PLAN_LIMITS[effectivePlan(user)];
  // An unknown plan (a suspended account, say) gets the most restrictive answer
  // rather than an accidental free pass.
  return limits ? limits.maxDevices : 0;
};

module.exports = {
  requireFeature, effectivePlan, trialIsActive, deviceAllowance, UNENTITLED_STATUSES,
};
