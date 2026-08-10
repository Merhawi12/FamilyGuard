import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  admin as adminApi, errorMessage, Icon, Toggle, useAuth,
  hasPermission, isSuperAdmin, PERMISSIONS, PLAN_CATALOGUE, PLAN_KEYS, planLabel,
} from '@parentix/shared';

/**
 * Settings — the platform's own configuration, in groups.
 *
 * It was one column of two cards with a save button hanging off the bottom.
 * The shape here is the one the reference design asks for and the one a
 * settings screen wants anyway: a list of groups on the left, one group at a
 * time on the right, and a footer that belongs to the whole form — what has
 * changed, discard it, or save it. Nothing is written until Save; Discard puts
 * the last saved values back, which is why the loaded settings are kept as a
 * baseline rather than only as the working copy.
 *
 * The group is in the URL (`?section=plans`), matching the family app's
 * settings screen, so a link can point at the part of the screen it means.
 *
 * What is *not* here is as deliberate as what is. The reference shows a support
 * address, a retention period and an API-key panel; the platform has no setting
 * behind any of the three — `GET /admin/settings` returns maintenance mode, the
 * trial length and the plan entitlements, and that is the whole of what the
 * console can change. A field that saved nowhere would be worse than a missing
 * one. The security group therefore points at the screens that really do hold
 * access control instead of inventing switches for it.
 */

const SECTIONS = [
  {
    key: 'general',
    label: 'General',
    title: 'General settings',
    description: 'Platform-wide switches. These apply to every account on Parentix.',
    editable: true,
  },
  {
    key: 'plans',
    label: 'Plans & features',
    title: 'Plans & features',
    description: 'Which features each subscription tier unlocks for the accounts on it.',
    editable: true,
  },
  {
    key: 'security',
    label: 'Access & security',
    title: 'Access & security',
    description: 'Who can reach the console, and where each control over that lives.',
    editable: false,
  },
];

/** The screens that really do govern access, gated exactly as the rail gates them. */
const ACCESS_LINKS = [
  {
    to: '/staff',
    icon: 'shield',
    label: 'Staff accounts',
    description: 'Who can sign in to the console, and what each department role may do.',
    superAdmin: true,
  },
  {
    to: '/sessions',
    icon: 'lock',
    label: 'Active sessions',
    description: 'Every signed-in device, and the control to sign one back out.',
    permission: PERMISSIONS.MANAGE_SESSIONS,
  },
  {
    to: '/audit-logs',
    icon: 'file',
    label: 'System logs',
    description: 'Every administrative action, with the operator behind it.',
    permission: PERMISSIONS.VIEW_AUDIT_LOGS,
  },
  {
    to: '/profile',
    icon: 'user',
    label: 'My profile',
    description: 'Your own password and the authenticator app protecting this account.',
  },
];

/** Only the three keys the API accepts — the rest of the payload is labels. */
const draftOf = (settings) => ({
  maintenanceMode: !!settings.maintenanceMode,
  defaultTrialDays: settings.defaultTrialDays,
  planFeatures: settings.planFeatures || {},
});

/**
 * A comparable form of a draft. Feature lists are sets, not sequences — ticking
 * a box and unticking it must come back to "no changes", and it would not if
 * the order the keys went in were part of the comparison.
 */
const fingerprint = (draft) => JSON.stringify({
  maintenanceMode: draft.maintenanceMode,
  defaultTrialDays: String(draft.defaultTrialDays),
  planFeatures: Object.fromEntries(
    Object.keys(draft.planFeatures).sort().map((plan) => [plan, [...draft.planFeatures[plan]].sort()])
  ),
});

/**
 * A settings field label. Uppercase and tracked out, as the reference has them:
 * on a panel this dense the labels have to read as scaffolding rather than
 * competing with the values typed into the fields below them.
 */
function FieldLabel({ htmlFor, children }) {
  return (
    <label
      htmlFor={htmlFor}
      className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500"
    >
      {children}
    </label>
  );
}

/**
 * A tick box for the plan matrix.
 *
 * The native box is kept — it is what carries the checked state to assistive
 * technology and to the keyboard — and hidden behind a drawn one, inside a 44px
 * label so the target is a target on a phone as well as under a mouse.
 */
function FeatureCheck({ checked, onChange, label }) {
  return (
    <label className="inline-flex items-center justify-center w-11 h-11 cursor-pointer group">
      <input
        type="checkbox"
        className="peer sr-only"
        aria-label={label}
        checked={checked}
        onChange={onChange}
      />
      <span
        aria-hidden="true"
        className="flex items-center justify-center w-[22px] h-[22px] rounded-md border-2 transition-colors
                   border-gray-300 text-transparent group-hover:border-primary-400
                   peer-checked:bg-primary-600 peer-checked:border-primary-600 peer-checked:text-white
                   peer-focus-visible:ring-2 peer-focus-visible:ring-primary-200 peer-focus-visible:ring-offset-1"
      >
        <Icon name="check" size={14} strokeWidth={3} />
      </span>
    </label>
  );
}

export default function AdminSettings() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();

  const [settings, setSettings] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);

  const requested = params.get('section');
  const section = SECTIONS.find((s) => s.key === requested) || SECTIONS[0];

  useEffect(() => {
    adminApi.getSettings()
      .then((r) => { setSettings(r.data); setBaseline(draftOf(r.data)); })
      .catch((e) => setError(errorMessage(e, 'Failed to load settings')));
  }, []);

  const selectSection = (key) => {
    setParams(key === SECTIONS[0].key ? {} : { section: key }, { replace: true });
  };

  /**
   * Left/Right and Up/Down walk the group list, Home/End jump to its ends — the
   * tablist pattern, and the reason these are `role="tab"` buttons rather than
   * links. Following focus with selection is what a tablist is expected to do.
   */
  const onTabKeyDown = (event) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();

    const here = SECTIONS.findIndex((s) => s.key === section.key);
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? SECTIONS.length - 1
        : forward ? (here + 1) % SECTIONS.length
          : (here - 1 + SECTIONS.length) % SECTIONS.length;

    selectSection(SECTIONS[next].key);
    event.currentTarget.querySelector(`#settings-tab-${SECTIONS[next].key}`)?.focus();
  };

  const draft = settings ? draftOf(settings) : null;
  const dirty = !!draft && !!baseline && fingerprint(draft) !== fingerprint(baseline);

  // An empty field is a state the operator passes through while typing, not a
  // value: it must not snap back to 1 under them, and it must not be saved.
  const trialDays = Number(settings?.defaultTrialDays);
  const trialValid = Number.isInteger(trialDays) && trialDays >= 1;

  const toggleFeature = (plan, feature) => {
    setSettings((s) => {
      const current = s.planFeatures[plan] || [];
      const updated = current.includes(feature) ? current.filter((f) => f !== feature) : [...current, feature];
      return { ...s, planFeatures: { ...s.planFeatures, [plan]: updated } };
    });
  };

  const handleDiscard = () => {
    if (!baseline) return;
    setError(''); setSaved('');
    setSettings((s) => ({ ...s, ...baseline, planFeatures: { ...baseline.planFeatures } }));
  };

  const handleSave = async () => {
    if (!trialValid) return;
    setSaving(true); setError(''); setSaved('');
    const payload = { ...draft, defaultTrialDays: trialDays };
    try {
      await adminApi.updateSettings(payload);
      setBaseline({ ...payload, planFeatures: { ...payload.planFeatures } });
      setSaved('Settings saved');
      setTimeout(() => setSaved(''), 2500);
    } catch (e) { setError(errorMessage(e, 'Failed to save settings')); }
    finally { setSaving(false); }
  };

  if (error && !settings) return <p className="notice-error">{error}</p>;
  if (!settings) return <p className="text-sm text-gray-400 py-8">Loading settings…</p>;

  const featureKeys = Object.keys(settings.featureLabels);
  const has = (plan, key) => (settings.planFeatures[plan] || []).includes(key);
  const allows = (item) => {
    if (item.superAdmin) return isSuperAdmin(user);
    if (item.permission) return hasPermission(user, item.permission);
    return true;
  };

  return (
    <div className="lg:flex lg:gap-6 lg:items-start">
      {/* The group picker: a scrolling row of pills on a phone, a list beside
          the panel from `lg` up, where it follows the page as it scrolls. */}
      <nav aria-label="Settings sections" className="lg:w-56 lg:shrink-0 lg:sticky lg:top-24 mb-4 lg:mb-0">
        <div className="-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto no-scrollbar lg:overflow-visible">
          <div
            role="tablist"
            aria-orientation="vertical"
            aria-label="Settings sections"
            onKeyDown={onTabKeyDown}
            className="flex lg:flex-col gap-1.5 w-max lg:w-full"
          >
            {SECTIONS.map(({ key, label }) => {
              const active = key === section.key;
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  id={`settings-tab-${key}`}
                  aria-selected={active}
                  aria-controls={`settings-panel-${key}`}
                  tabIndex={active ? 0 : -1}
                  onClick={() => selectSection(key)}
                  className={`group flex items-center gap-2 min-h-[44px] px-3.5 rounded-xl
                              text-sm font-semibold whitespace-nowrap transition-colors lg:w-full
                              ${active
      ? 'bg-primary-50 text-primary-700'
      : 'text-gray-600 hover:bg-white hover:text-gray-900 active:bg-gray-100'}`}
                >
                  <span className="flex-1 text-left">{label}</span>
                  <Icon
                    name="chevronRight"
                    size={16}
                    strokeWidth={2.4}
                    className={`shrink-0 transition-all duration-200
                                ${active
      ? 'opacity-100 translate-x-0'
      : 'opacity-0 -translate-x-1 group-hover:opacity-50 group-hover:translate-x-0'}`}
                  />
                </button>
              );
            })}
          </div>
        </div>
      </nav>

      {/* The panel. One `card-flush` so the header rule and the footer bar run
          the full width of it rather than stopping inside the padding. */}
      <section
        role="tabpanel"
        id={`settings-panel-${section.key}`}
        aria-labelledby={`settings-tab-${section.key}`}
        tabIndex={0}
        className="card-flush flex-1 min-w-0 max-w-3xl focus-visible:outline-none"
      >
        <header className="px-4 sm:px-7 pt-5 sm:pt-6 pb-4 sm:pb-5 border-b border-gray-100">
          <h2 className="text-lg sm:text-2xl font-bold tracking-tight text-gray-900">{section.title}</h2>
          <p className="text-sm text-gray-500 mt-1">{section.description}</p>
        </header>

        <div className="px-4 sm:px-7 py-5 sm:py-6 space-y-5">
          {error && <p className="notice-error">{error}</p>}

          {section.key === 'general' && (
            <>
              <div className="rounded-xl border border-gray-200 px-4 py-1">
                <Toggle
                  label="Maintenance mode"
                  description="Show a maintenance banner and block new sign-ins."
                  checked={!!settings.maintenanceMode}
                  onChange={(v) => setSettings({ ...settings, maintenanceMode: v })}
                />
              </div>

              {settings.maintenanceMode && (
                <p className="notice-warning">
                  <Icon name="warning" size={18} className="shrink-0 mt-px" />
                  <span>
                    While this is on, parents cannot sign in and the apps show a maintenance notice.
                    Sessions already open are not affected.
                  </span>
                </p>
              )}

              <div className="space-y-1.5">
                <FieldLabel htmlFor="trial-days">Default trial period</FieldLabel>
                <div className="relative sm:max-w-xs">
                  <input
                    id="trial-days"
                    type="number"
                    min="1"
                    inputMode="numeric"
                    aria-describedby="trial-days-hint"
                    aria-invalid={!trialValid}
                    className={`input pr-16 ${trialValid ? '' : 'border-danger focus:border-danger focus:ring-red-100'}`}
                    value={settings.defaultTrialDays}
                    onChange={(e) => setSettings({ ...settings, defaultTrialDays: e.target.value })}
                  />
                  <span
                    className="absolute inset-y-0 right-3.5 flex items-center text-sm text-gray-400 pointer-events-none"
                    aria-hidden="true"
                  >
                    Days
                  </span>
                </div>
                <p id="trial-days-hint" className={`text-xs ${trialValid ? 'text-gray-400' : 'text-danger'}`}>
                  {trialValid
                    ? 'Days of full Premium access a new account starts with.'
                    : 'Enter a whole number of days, at least 1.'}
                </p>
              </div>
            </>
          )}

          {section.key === 'plans' && (
            <>
              {/* The catalogue, so the columns below are read against the price
                  and the device allowance they belong to. Both come from
                  `config/plans.js` and are not editable here — a tier invented
                  in the console would have no Stripe price to charge. */}
              <div className="grid sm:grid-cols-2 gap-3">
                {PLAN_CATALOGUE.map((plan) => (
                  <div key={plan.key} className="rounded-xl border border-gray-200 p-4">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-sm font-semibold text-gray-900">{plan.label}</p>
                      <p className="text-sm font-semibold text-gray-900 shrink-0">
                        {plan.price}
                        <span className="text-xs font-medium text-gray-400"> {plan.period}</span>
                      </p>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {(settings.planFeatures[plan.key] || []).length} of {featureKeys.length} features
                      {' · '}
                      {plan.maxDevices === null ? 'Unlimited devices' : `${plan.maxDevices} device`}
                    </p>
                  </div>
                ))}
              </div>

              {/* A feature/plan matrix is the right shape on a wide screen and
                  the wrong one on a phone, where the feature names alone need
                  the full width. Below `lg` each feature becomes a block with
                  its plan boxes underneath it. */}
              <div className="lg:hidden divide-y divide-gray-100 -my-1">
                {featureKeys.map((key) => (
                  <div key={key} className="py-3">
                    <p className="text-sm font-medium text-gray-900">{settings.featureLabels[key]}</p>
                    <div className="flex flex-wrap gap-2 mt-1.5">
                      {PLAN_KEYS.map((plan) => (
                        <label
                          key={plan}
                          className={`chip cursor-pointer focus-within:ring-2 focus-within:ring-primary-200
                                      focus-within:ring-offset-1 ${has(plan, key) ? 'chip-active' : ''}`}
                        >
                          <input
                            type="checkbox"
                            className="peer sr-only"
                            checked={has(plan, key)}
                            onChange={() => toggleFeature(plan, key)}
                          />
                          <Icon
                            name={has(plan, key) ? 'check' : 'plus'}
                            size={15}
                            strokeWidth={2.6}
                            className="shrink-0"
                          />
                          {planLabel(plan)}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="hidden lg:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500">
                      <th className="py-2 pr-4 text-[11px] font-semibold uppercase tracking-[0.14em]">
                        Feature
                      </th>
                      {PLAN_KEYS.map((plan) => (
                        <th
                          key={plan}
                          scope="col"
                          className="py-2 w-32 text-center text-[11px] font-semibold uppercase tracking-[0.14em]"
                        >
                          {planLabel(plan)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {featureKeys.map((key) => (
                      <tr key={key} className="border-t border-gray-100">
                        <th scope="row" className="py-1 pr-4 font-medium text-left text-gray-900">
                          {settings.featureLabels[key]}
                        </th>
                        {PLAN_KEYS.map((plan) => (
                          <td key={plan} className="py-1 text-center">
                            <FeatureCheck
                              checked={has(plan, key)}
                              onChange={() => toggleFeature(plan, key)}
                              label={`${settings.featureLabels[key]} on the ${planLabel(plan)}`}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {section.key === 'security' && (
            <>
              <p className="notice-info">
                <Icon name="info" size={18} className="shrink-0 mt-px" />
                <span>
                  Password rules, sign-in throttling and token lifetimes are enforced by the API
                  itself, not configured here. Everything that can be changed is on one of these
                  screens.
                </span>
              </p>

              <ul className="space-y-2">
                {ACCESS_LINKS.filter(allows).map(({ to, icon, label, description }) => (
                  <li key={to}>
                    <Link
                      to={to}
                      className="flex items-center gap-3.5 min-h-[64px] px-3.5 py-3 rounded-xl border border-gray-200
                                 transition-colors hover:border-primary-200 hover:bg-primary-50/40 active:bg-primary-50 group"
                    >
                      <span
                        className="flex items-center justify-center w-10 h-10 shrink-0 rounded-xl
                                   bg-gray-100 text-gray-500 transition-colors
                                   group-hover:bg-primary-100 group-hover:text-primary-700"
                        aria-hidden="true"
                      >
                        <Icon name={icon} size={19} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-gray-900">{label}</span>
                        <span className="block text-xs text-gray-500 mt-0.5">{description}</span>
                      </span>
                      <Icon
                        name="chevronRight"
                        size={16}
                        strokeWidth={2.4}
                        className="shrink-0 text-gray-300 transition-colors group-hover:text-primary-600"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        {/* The footer belongs to the whole form, not to the group on screen:
            one PUT carries every setting, so a change made under General is
            still pending while Plans & features is open — and the counter says
            so rather than letting it be saved by surprise or lost on a reload. */}
        {section.editable && (
          <footer className="flex flex-wrap items-center justify-end gap-2 px-4 sm:px-7 py-3.5
                             border-t border-gray-100 bg-gray-50/70">
            <p
              className="flex-1 min-w-full sm:min-w-0 text-xs font-medium"
              role="status"
              aria-live="polite"
            >
              {saved ? (
                <span className="inline-flex items-center gap-1.5 text-green-700">
                  <Icon name="check" size={15} strokeWidth={2.6} />
                  {saved}
                </span>
              ) : dirty ? (
                <span className="inline-flex items-center gap-1.5 text-amber-600">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                  Unsaved changes
                </span>
              ) : (
                <span className="text-gray-400">All changes saved</span>
              )}
            </p>

            <button
              type="button"
              onClick={handleDiscard}
              disabled={!dirty || saving}
              className="btn-ghost btn-sm min-h-[40px] px-3.5"
            >
              Discard changes
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !dirty || !trialValid}
              className="btn-primary btn-sm min-h-[40px] px-4"
            >
              <Icon name="check" size={16} strokeWidth={2.6} />
              {saving ? 'Saving…' : 'Save configuration'}
            </button>
          </footer>
        )}
      </section>
    </div>
  );
}
