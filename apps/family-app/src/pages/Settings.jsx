import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  useAuth, auth as authApi, payments, errorMessage, EmptyState, Icon, Toggle, TwoFactorSetup,
  PLAN_CATALOGUE, planLabel, isPaidPlan,
} from '@parentix/shared';
import PageIntro from '../components/PageIntro';
import PushSettings from '../components/PushSettings';
import ActiveSessions from '../components/ActiveSessions';
import DeleteAccount from '../components/DeleteAccount';

const SECTIONS = [
  { key: 'security', label: 'Security', icon: 'lock' },
  { key: 'notifications', label: 'Notifications', icon: 'bell' },
  { key: 'plan', label: 'Plan & billing', icon: 'card' },
  { key: 'about', label: 'About', icon: 'info' },
];

/* The cards come from the shared catalogue rather than a copy kept here. This
   list said "Up to 5 child devices" for Premium while the API enforced no limit
   at all and Family Plus claimed the unlimited tier — three descriptions of one
   product, none of them true. */

/*
 * Only alerts the platform can actually raise are listed — a switch that
 * promises an alert which can never arrive is worse than no switch.
 *
 * All three that used to fail that rule have been resolved rather than hidden:
 * `dangerous_content` and `app_installed` are now raised by real producers (the
 * API's risky-browsing check and the device's first-seen-app check), and
 * `unknown_contact` was removed from the platform — matching a caller needs
 * call-log and SMS permissions Parentix does not ask a family for. So this list
 * is once again the whole catalogue, and
 * `services/api/tests/alertCatalogue.test.js` asserts it stays that way in both
 * directions: nothing offered that cannot fire, nothing that can fire left out.
 */
const ALERT_TYPES = [
  { key: 'emergency_button', label: 'Emergency button' },
  { key: 'cyberbullying', label: 'Cyberbullying detected' },
  { key: 'safety_pattern', label: 'AI safety patterns' },
  { key: 'screen_time_exceeded', label: 'Screen time reached' },
  { key: 'left_safe_zone', label: 'Left safe zone' },
  { key: 'entered_safe_zone', label: 'Arrived at safe zone' },
  { key: 'blocked_app_attempt', label: 'Blocked app attempt' },
  { key: 'dangerous_content', label: 'Risky site opened' },
  { key: 'app_installed', label: 'New app used' },
];

/**
 * Everything configurable about the account, in four sections.
 *
 * It was one column of eight unrelated cards — identity, password, two-factor,
 * three subscription tiers, push subscriptions and eleven alert toggles — about
 * six phone screens tall, with no way to link anyone to a particular part of it.
 * Identity moved to Profile; what is left is grouped, one group at a time, and
 * the group is in the URL (`?section=plan`) so Profile and a Stripe return can
 * both land on the right one.
 */
export default function Settings() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();

  const requested = params.get('section');
  const section = SECTIONS.some((s) => s.key === requested) ? requested : 'security';

  const [passwords, setPasswords] = useState({ current: '', next: '', confirm: '' });
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState('');
  const [passwordError, setPasswordError] = useState('');

  const [subscription, setSubscription] = useState(null);
  const [loadingPlan, setLoadingPlan] = useState(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [planMessage, setPlanMessage] = useState('');
  const [planError, setPlanError] = useState('');

  const [notifPrefs, setNotifPrefs] = useState(null);
  const [notifSaving, setNotifSaving] = useState(false);
  const [notifMessage, setNotifMessage] = useState('');
  const [notifError, setNotifError] = useState('');
  // Distinct from `notifError`, which reports a failed *save*.
  const [notifLoadError, setNotifLoadError] = useState('');

  /**
   * A failed preferences load used to leave `notifPrefs` null forever, and the
   * only thing keyed off null is the "Loading your notification preferences…"
   * placeholder — so the screen that decides whether a parent is told their
   * child left a safe zone sat on a spinner that would never resolve, with no
   * error and no way to retry. Same rule as the alert list: an empty result and
   * a failed request are different answers and must not look alike.
   *
   * The subscription is genuinely optional — a free account has none, and the
   * plan section reads `user.plan` rather than this — so its failure stays quiet.
   */
  const loadNotifPrefs = useCallback(() => {
    setNotifLoadError('');
    return authApi.getNotificationPrefs()
      .then((r) => setNotifPrefs(r.data))
      .catch((err) => setNotifLoadError(errorMessage(err, 'Could not load your notification preferences.')));
  }, []);

  /**
   * Whether this deployment can take money at all.
   *
   * Defaults to `true` and only ever goes false on an explicit answer, so an
   * older API that does not report the field — or a request that simply fails —
   * leaves the plan screen exactly as it was. Hiding the way to pay is the more
   * expensive mistake of the two, so it is never done on a guess.
   */
  const [billingAvailable, setBillingAvailable] = useState(true);

  useEffect(() => {
    payments.getSubscription().then((r) => setSubscription(r.data)).catch(() => {});
    authApi.providers()
      .then((r) => { if (r.data?.billing === false) setBillingAvailable(false); })
      .catch(() => {});
    loadNotifPrefs();
  }, [loadNotifPrefs]);

  // Stripe sends the parent back here; land them on the billing section with
  // the outcome rather than at the top of a page that says nothing about it.
  useEffect(() => {
    const payment = params.get('payment');
    if (!payment) return;
    if (payment === 'success') setPlanMessage('Payment successful — your plan has been upgraded.');
    if (payment === 'cancelled') setPlanError('Payment was cancelled. Nothing has been charged.');
  }, [params]);

  const paymentOutcome = params.get('payment');
  const activeSection = paymentOutcome ? 'plan' : section;

  const selectSection = (key) => {
    setParams(key === 'security' ? {} : { section: key }, { replace: true });
  };

  const changePassword = async (e) => {
    e.preventDefault();
    setPasswordError(''); setPasswordMessage('');

    if (passwords.next !== passwords.confirm) return setPasswordError('The new passwords do not match.');
    if (hasPassword && passwords.next === passwords.current) {
      return setPasswordError('The new password must be different.');
    }

    setSavingPassword(true);
    try {
      const res = await authApi.changePassword({
        ...(hasPassword ? { currentPassword: passwords.current } : {}),
        newPassword: passwords.next,
      });
      setPasswords({ current: '', next: '', confirm: '' });
      // A password change now signs out every other session, so say which — a
      // parent who changed it because they suspected someone else was in the
      // account needs to see that the someone else was actually evicted.
      setPasswordMessage(res.data?.message || 'Your password has been changed.');
      setTimeout(() => setPasswordMessage(''), 6000);
    } catch (err) {
      setPasswordError(errorMessage(err, 'Could not change your password.'));
    } finally {
      setSavingPassword(false);
    }
  };

  const handleUpgrade = async (plan) => {
    setLoadingPlan(plan);
    setPlanError('');
    try {
      const res = await payments.createCheckoutSession(plan);
      window.location.href = res.data.url;
    } catch (err) {
      setPlanError(errorMessage(err, 'Could not start checkout.'));
      setLoadingPlan(null);
    }
  };

  const handlePortal = async () => {
    setPortalLoading(true);
    setPlanError('');
    try {
      const res = await payments.customerPortal();
      window.location.href = res.data.url;
    } catch (err) {
      setPlanError(errorMessage(err, 'Could not open the billing portal.'));
      setPortalLoading(false);
    }
  };

  const saveNotifPrefs = async () => {
    setNotifSaving(true);
    setNotifError('');
    try {
      await authApi.updateNotificationPrefs(notifPrefs);
      setNotifMessage('Preferences saved.');
      setTimeout(() => setNotifMessage(''), 3000);
    } catch (err) {
      setNotifError(errorMessage(err, 'Could not save your preferences.'));
    } finally {
      setNotifSaving(false);
    }
  };

  // Derived from the catalogue, so retiring or adding a tier does not leave a
  // hard-coded list here deciding who sees the billing-portal button.
  const isPaid = isPaidPlan(user?.plan);
  // Absent on a session issued before this field shipped; treated as "has one",
  // which is the safe reading — it shows the current-password box rather than
  // hiding it from an account that needs it.
  const hasPassword = user?.hasPassword !== false;

  return (
    <div className="lg:flex lg:gap-8 lg:items-start">
      {/* Section picker: a scrolling chip row on a phone, a list beside the
          content from `lg` up. */}
      <nav
        aria-label="Settings sections"
        className="lg:w-56 lg:shrink-0 lg:sticky lg:top-24 mb-5 lg:mb-0"
      >
        <div className="-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto no-scrollbar lg:overflow-visible">
          <div className="flex lg:flex-col gap-2 w-max lg:w-full">
            {SECTIONS.map(({ key, label, icon }) => {
              const active = activeSection === key;
              return (
                <button
                  key={key}
                  onClick={() => selectSection(key)}
                  aria-current={active ? 'page' : undefined}
                  className={`chip lg:w-full lg:justify-start ${active ? 'chip-active' : ''}`}
                >
                  <Icon name={icon} size={18} />
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </nav>

      <div className="flex-1 min-w-0 space-y-5 max-w-2xl">
        {activeSection === 'security' && (
          <>
            <PageIntro description="Your password and the second factor protecting this account." />

            <div className="card">
              <h2 className="section-title mb-1">{hasPassword ? 'Change password' : 'Set a password'}</h2>
              {!hasPassword && (
                <p className="text-sm text-gray-500 mb-3">
                  You signed up with {user?.phone && !user?.email ? 'a phone number' : 'Google'}, so this
                  account has no password yet. Setting one gives you a second way to sign in.
                </p>
              )}

              {passwordError && <p className="notice-error mb-3">{passwordError}</p>}
              {passwordMessage && <p className="notice-success mb-3">{passwordMessage}</p>}

              <form onSubmit={changePassword} className="space-y-4">
                {/* Hidden rather than disabled for an account with none: the
                    field had no possible correct value, so every submission
                    answered "Current password is incorrect". */}
                {hasPassword && (
                  <label className="field">
                    <span className="field-label">Current password</span>
                    <input
                      className="input" type="password" autoComplete="current-password" required
                      value={passwords.current}
                      onChange={(e) => setPasswords({ ...passwords, current: e.target.value })}
                    />
                  </label>
                )}
                <label className="field">
                  <span className="field-label">New password</span>
                  <input
                    className="input" type="password" autoComplete="new-password" required
                    value={passwords.next}
                    onChange={(e) => setPasswords({ ...passwords, next: e.target.value })}
                  />
                  <span className="field-hint">At least 10 characters, including a letter and a number.</span>
                </label>
                <label className="field">
                  <span className="field-label">Confirm new password</span>
                  <input
                    className="input" type="password" autoComplete="new-password" required
                    value={passwords.confirm}
                    onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })}
                  />
                </label>
                <button type="submit" className="btn-primary btn-block sm:w-auto" disabled={savingPassword}>
                  {savingPassword
                    ? 'Saving…'
                    : hasPassword ? 'Change password' : 'Set password'}
                </button>
              </form>
            </div>

            <TwoFactorSetup />

            {/* The follow-up the "signed in from a new device" email assumes
                exists, and the way out of the product. Both are account
                security, so both live under Security. */}
            <ActiveSessions />

            <DeleteAccount />
          </>
        )}

        {activeSection === 'notifications' && (
          <>
            <PageIntro description="How and when Parentix should reach you." />

            <PushSettings />

            {notifPrefs ? (
              <>
                <div className="card">
                  <h2 className="section-title mb-1">Delivery</h2>
                  <p className="text-sm text-gray-500 mb-2">Where alerts are sent.</p>

                  <div className="divide-y divide-gray-50">
                    {/* An account created from a phone number has no address, and
                        the alert pipeline skips the email channel for it
                        entirely. The switch was still drawn — under the label
                        "Sent to " with nothing after it — offering to turn on a
                        channel that could never deliver and reporting an address
                        that does not exist. */}
                    {user?.email ? (
                      <Toggle
                        label="Email alerts"
                        description={`Sent to ${user.email}`}
                        checked={!!notifPrefs.emailAlerts}
                        onChange={(v) => setNotifPrefs((p) => ({ ...p, emailAlerts: v }))}
                      />
                    ) : (
                      <div className="py-3">
                        <p className="text-sm font-medium text-gray-900">Email alerts</p>
                        <p className="text-sm text-gray-500 mt-0.5">
                          This account has no email address, so alerts are delivered by push only.
                          Add one under{' '}
                          <Link to="/dashboard/profile" className="text-primary-600 font-medium hover:underline">
                            Profile
                          </Link>{' '}
                          to turn this on.
                        </p>
                      </div>
                    )}
                    {user?.email && notifPrefs.emailAlerts && (
                      <div className="pl-4 border-l-2 border-primary-100 ml-1">
                        <Toggle
                          label="High severity only"
                          description="Only email me about critical alerts"
                          checked={!!notifPrefs.emailHighOnly}
                          onChange={(v) => setNotifPrefs((p) => ({ ...p, emailHighOnly: v }))}
                        />
                      </div>
                    )}
                    {/* Named for what it actually governs. It said "every
                        browser", which left out the Android app — the place most
                        parents read these — and it now also covers messages from
                        a child, which used to reach nothing at all when the
                        dashboard was closed. */}
                    <Toggle
                      label="Push notifications"
                      description="Alerts and messages from your children, on every device you have enabled notifications on"
                      checked={!!notifPrefs.pushAlerts}
                      onChange={(v) => setNotifPrefs((p) => ({ ...p, pushAlerts: v }))}
                    />
                  </div>
                </div>

                <div className="card">
                  <h2 className="section-title mb-1">Alert types</h2>
                  <p className="text-sm text-gray-500 mb-2">Which events are worth interrupting you for.</p>

                  <div className="divide-y divide-gray-50">
                    {ALERT_TYPES.map(({ key, label }) => (
                      <Toggle
                        key={key}
                        label={label}
                        size="sm"
                        checked={!!notifPrefs.alertTypes?.[key]}
                        onChange={(v) =>
                          setNotifPrefs((p) => ({ ...p, alertTypes: { ...p.alertTypes, [key]: v } }))
                        }
                      />
                    ))}
                  </div>
                </div>

                {notifError && <p className="notice-error">{notifError}</p>}
                {notifMessage && <p className="notice-success">{notifMessage}</p>}

                <button onClick={saveNotifPrefs} className="btn-primary btn-block sm:w-auto" disabled={notifSaving}>
                  {notifSaving ? 'Saving…' : 'Save preferences'}
                </button>
              </>
            ) : notifLoadError ? (
              <div className="card space-y-3">
                <EmptyState
                  icon="warning"
                  title="Could not load your notification preferences"
                  description={notifLoadError}
                />
                <button onClick={loadNotifPrefs} className="btn-secondary btn-block sm:w-auto">
                  Try again
                </button>
              </div>
            ) : (
              <div className="card text-sm text-gray-400">Loading your notification preferences…</div>
            )}
          </>
        )}

        {activeSection === 'plan' && (
          <>
            <PageIntro description="Your subscription and what it includes." />

            {planMessage && <p className="notice-success">{planMessage}</p>}
            {planError && <p className="notice-error">{planError}</p>}

            <div className="card">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-gray-500">Current plan</p>
                  {/* A chained ternary made "Family Plus" the fallback, so a
                      suspended account read as the most expensive tier. */}
                  <p className="text-lg font-semibold text-primary-600">{planLabel(user?.plan)}</p>
                  {subscription?.currentPeriodEnd && (
                    <p className="text-xs text-gray-400 mt-1">
                      Renews {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
                      {subscription.cancelAtPeriodEnd && ' — cancels at the end of this period'}
                    </p>
                  )}
                </div>
                {isPaid && billingAvailable && (
                  <button onClick={handlePortal} disabled={portalLoading} className="btn-secondary btn-sm shrink-0">
                    {portalLoading ? 'Opening…' : 'Manage billing'}
                  </button>
                )}
              </div>

              {user?.plan === 'free' && user?.trialEndsAt && (
                <p className={`notice mt-4 ${user.trialExpired ? 'notice-error' : 'notice-warning'}`}>
                  <Icon name="warning" size={16} className="mt-0.5" />
                  <span>
                    {/* Telling a parent to upgrade is only fair when upgrading is
                        possible. With billing off the sentence would name a button
                        that is not on the page. */}
                    {user.trialExpired
                      ? `Your free trial has expired.${billingAvailable ? ' Upgrade to keep monitoring your family.' : ''}`
                      : `Your trial ends ${new Date(user.trialEndsAt).toLocaleDateString()} — ${Math.max(
                        0,
                        Math.ceil((new Date(user.trialEndsAt) - Date.now()) / 86400000)
                      )} days left.`}
                  </span>
                </p>
              )}

              {!billingAvailable && (
                <p className="notice notice-info mt-4">
                  <Icon name="info" size={16} className="mt-0.5" />
                  <span>
                    Online payment is not available on this deployment yet, so plans
                    cannot be changed here. Please contact support to change your plan.
                  </span>
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {PLAN_CATALOGUE.map(({ key: plan, label, price, period, badge, popular, features, warning }) => {
                const isCurrent = user?.plan === plan;
                return (
                  <div
                    key={plan}
                    className={`relative card flex flex-col ${
                      isCurrent ? 'border-primary-500 ring-1 ring-primary-500' : ''
                    } ${popular && !isCurrent ? 'mt-3 md:mt-0' : ''}`}
                  >
                    {popular && !isCurrent && (
                      <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary-600 text-white text-[11px] font-bold px-3 py-1 rounded-full whitespace-nowrap">
                        Most popular
                      </span>
                    )}

                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold">{label}</p>
                      {badge && <span className="badge-amber">{badge}</span>}
                      {isCurrent && <span className="badge-primary ml-auto">Active</span>}
                    </div>

                    <p className="text-2xl font-bold text-primary-600 mt-2 mb-4">
                      {price}
                      <span className="text-xs text-gray-400 font-normal">{period}</span>
                    </p>

                    <ul className="text-sm text-gray-600 space-y-2 flex-1 mb-5">
                      {features.map((f) => (
                        <li key={f} className="flex items-start gap-2">
                          <Icon name="check" size={15} strokeWidth={2.5} className="text-primary-500 mt-0.5" />
                          <span>{f}</span>
                        </li>
                      ))}
                      {warning && (
                        <li className="flex items-start gap-2 text-amber-600 font-medium">
                          <Icon name="warning" size={15} className="mt-0.5" />
                          <span>{warning}</span>
                        </li>
                      )}
                    </ul>

                    {!isCurrent && plan !== 'free' && billingAvailable && (
                      <button
                        onClick={() => handleUpgrade(plan)}
                        disabled={loadingPlan === plan}
                        className="btn-primary btn-block"
                      >
                        {loadingPlan === plan ? 'Redirecting…' : `Upgrade to ${label}`}
                      </button>
                    )}
                    {isCurrent && isPaid && billingAvailable && (
                      <button onClick={handlePortal} disabled={portalLoading} className="btn-secondary btn-block">
                        {portalLoading ? 'Opening…' : 'Manage or cancel'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {activeSection === 'about' && (
          <>
            <PageIntro description="Legal documents, support, and what this build is." />

            <div className="card-flush divide-y divide-gray-50">
              {[
                { to: '/privacy-policy', icon: 'file', label: 'Privacy Policy' },
                { to: '/terms', icon: 'file', label: 'Terms of Service' },
              ].map(({ to, icon, label }) => (
                <Link key={to} to={to} className="list-row rounded-none px-4 hover:bg-gray-50">
                  <span className="w-9 h-9 rounded-xl bg-gray-50 text-gray-500 flex items-center justify-center shrink-0">
                    <Icon name={icon} size={18} />
                  </span>
                  <span className="flex-1 text-sm font-medium text-gray-900">{label}</span>
                  <Icon name="chevronRight" size={16} className="text-gray-300" />
                </Link>
              ))}
              <a href="/contact" className="list-row rounded-none px-4 hover:bg-gray-50">
                <span className="w-9 h-9 rounded-xl bg-gray-50 text-gray-500 flex items-center justify-center shrink-0">
                  <Icon name="mail" size={18} />
                </span>
                <span className="flex-1 text-sm font-medium text-gray-900">Contact support</span>
                <Icon name="external" size={16} className="text-gray-300" />
              </a>
            </div>

            <div className="card">
              <h2 className="section-title mb-3">About Parentix</h2>
              <dl className="text-sm space-y-2">
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">Signed in as</dt>
                  {/* A phone-number account has no address, and this rendered an
                      empty cell next to the label. Whichever identifier the
                      account actually has is the one worth naming. */}
                  <dd className="text-gray-900 truncate">{user?.email || user?.phone || '—'}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">Plan</dt>
                  <dd className="text-gray-900">{planLabel(user?.plan)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">Version</dt>
                  <dd className="text-gray-900">{__APP_VERSION__}</dd>
                </div>
              </dl>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
