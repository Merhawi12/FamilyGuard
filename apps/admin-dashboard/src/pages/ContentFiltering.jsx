import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  admin as adminApi, errorMessage, EmptyState, Icon, Toggle,
} from '@parentix/shared';
import DataTable from '../components/DataTable';

/**
 * Content Filtering — the policy every child device is subject to.
 *
 * Two halves that look alike and are not. The **policy** is set here and
 * enforced everywhere: a category is expanded into domains on the server
 * (`utils/contentPolicy.js`) and handed to each device with its own rules, so
 * switching one on changes what phones block on their next sync. The **activity**
 * is a report on what the fleet did with it, measured from the blocked lookups
 * the devices report — nothing on this screen is an estimate.
 *
 * Categories are a draft with an explicit Save, because a switch here reaches
 * every device on the platform and that deserves a deliberate second action.
 * Domain rules are their own explicit actions — Add rule, delete — so they apply
 * as they are made.
 *
 * What the reference design asked for and this cannot honour: an alert threshold
 * with email/SMS notification. There is no SMS provider in the platform and no
 * channel that notifies administrators of anything — alerts go to the parent who
 * owns the child. Inventing the card would have meant a slider that governed
 * nothing, so the space reports the enforcement that is real instead.
 */

const STRENGTH = {
  off: { label: 'No policy', badge: 'badge-gray' },
  light: { label: 'Light', badge: 'badge-blue' },
  standard: { label: 'Standard', badge: 'badge-amber' },
  strict: { label: 'Strict', badge: 'badge-red' },
};

const RULE_ACTIONS = [
  { value: 'block', label: 'Block (blacklist)' },
  { value: 'allow', label: 'Allow (whitelist)' },
];

const sameSet = (a = [], b = []) =>
  a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

const formatDate = (value) => {
  const date = new Date(value ?? NaN);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

/** One card of the right-hand column, so the two read as a set. */
function SideCard({ icon, title, subtitle, children }) {
  return (
    <section className="card p-4 sm:p-5">
      <div className="flex items-start gap-2.5">
        <span className="flex items-center justify-center w-8 h-8 shrink-0 rounded-lg bg-primary-50 text-primary-600" aria-hidden="true">
          <Icon name={icon} size={17} />
        </span>
        <div className="min-w-0">
          <h2 className="section-title">{title}</h2>
          {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * Blocked lookups by category, as bars.
 *
 * Horizontal rather than the reference's vertical columns: a category name is
 * "AI Safety & Cyberbullying Detection" long, and a vertical bar chart can only
 * carry that by turning the labels on their side, which nobody reads.
 */
function CategoryBars({ rows, windowDays }) {
  const max = Math.max(...rows.map((r) => r.attempts), 1);

  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <li key={row.key}>
          <div className="flex items-baseline justify-between gap-3 mb-1">
            <span className="text-sm text-gray-700 truncate">{row.label}</span>
            <span className="text-sm font-semibold text-gray-900 shrink-0 tabular-nums">
              {row.attempts.toLocaleString()}
            </span>
          </div>
          <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
            <div
              className={`h-full rounded-full ${row.attempts ? 'bg-primary-600' : 'bg-transparent'}`}
              style={{ width: `${(row.attempts / max) * 100}%` }}
              role="img"
              aria-label={`${row.label}: ${row.attempts} blocked attempts in the last ${windowDays} days`}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function ContentFiltering() {
  const [data, setData] = useState(null);
  const [categories, setCategories] = useState([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ domain: '', action: 'block' });
  const [adding, setAdding] = useState(false);

  const load = () => adminApi.getContentFiltering()
    .then((r) => { setData(r.data); setCategories(r.data.policy.categories); })
    .catch((e) => setError(errorMessage(e, 'Failed to load the filtering policy')));

  useEffect(() => { load(); }, []);

  const policy = data?.policy;
  const dirty = !!policy && !sameSet(categories, policy.categories);

  const toggleCategory = (key) => {
    setSaved('');
    setCategories((keys) => (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]));
  };

  /** One PUT for the whole policy; the half not being edited is left out. */
  const write = async (payload, message) => {
    setError(''); setSaved('');
    const res = await adminApi.updateContentFiltering(payload);
    setData((d) => ({ ...d, policy: res.data.policy, strength: res.data.strength }));
    setSaved(message);
    setTimeout(() => setSaved(''), 2500);
    return res.data.policy;
  };

  const saveCategories = async () => {
    setSaving(true);
    try {
      const next = await write({ categories }, 'Filtering policy saved');
      setCategories(next.categories);
      // The domain counts and the coverage figures move with the policy.
      load();
    } catch (e) { setError(errorMessage(e, 'Failed to save the filtering policy')); }
    finally { setSaving(false); }
  };

  const addRule = async (e) => {
    e.preventDefault();
    const domain = form.domain.trim();
    if (!domain) return;

    setAdding(true);
    try {
      // Re-adding a domain replaces the rule rather than storing it twice — the
      // second entry could only ever contradict the first.
      const rest = policy.domainRules.filter((r) => r.domain !== domain.toLowerCase().replace(/^www\./, ''));
      await write({ domainRules: [...rest, { domain, action: form.action }] }, 'Rule added');
      setForm({ domain: '', action: 'block' });
      load();
    } catch (err) { setError(errorMessage(err, 'Could not add that rule')); }
    finally { setAdding(false); }
  };

  const removeRule = async (domain) => {
    try {
      await write({ domainRules: policy.domainRules.filter((r) => r.domain !== domain) }, 'Rule removed');
      load();
    } catch (err) { setError(errorMessage(err, 'Could not remove that rule')); }
  };

  if (error && !data) return <p className="notice-error">{error}</p>;
  if (!data) return <p className="text-sm text-gray-400 py-8">Loading the filtering policy…</p>;

  const { catalogue, summary, windowDays } = data;
  const strength = STRENGTH[data.strength] || STRENGTH.off;
  const attempts = summary.blockedAttempts;

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500 max-w-3xl">
        Manage the access policy every linked device enforces, choose the content categories
        the platform blocks by default, and see what those rules actually stopped.
      </p>

      {error && <p className="notice-error">{error}</p>}
      {saved && <p className="notice-success"><Icon name="check" size={17} className="shrink-0 mt-px" />{saved}</p>}

      <div className="grid xl:grid-cols-3 gap-5 items-start">
        <div className="xl:col-span-2 space-y-5">
          {/* ── The policy ──────────────────────────────────────────────── */}
          <section className="card-flush">
            <header className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-5 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="flex items-center justify-center w-8 h-8 shrink-0 rounded-lg bg-primary-50 text-primary-600" aria-hidden="true">
                  <Icon name="filter" size={17} />
                </span>
                <div className="min-w-0">
                  <h2 className="section-title">Global filter categories</h2>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Blocked on every linked device, on top of whatever each parent sets.
                  </p>
                </div>
              </div>
              <span className={`${strength.badge} uppercase tracking-wide text-[10px] font-semibold shrink-0`}>
                Active policy: {strength.label}
              </span>
            </header>

            <div className="p-4 sm:p-5 grid sm:grid-cols-2 gap-3">
              {catalogue.map((category) => {
                const on = categories.includes(category.key);
                return (
                  <div
                    key={category.key}
                    className={`flex items-center gap-3 min-h-[76px] px-4 py-3 rounded-xl border transition-colors
                                ${on ? 'border-primary-200 bg-primary-50/50' : 'border-gray-200 bg-white'}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-gray-900">{category.label}</p>
                      <p className="text-xs text-gray-500 mt-0.5 truncate">{category.description}</p>
                      <p className="text-[11px] text-gray-400 mt-1">
                        {category.domainCount} domains
                      </p>
                    </div>
                    <Toggle
                      checked={on}
                      onChange={() => toggleCategory(category.key)}
                      aria-label={`Block ${category.label} across the platform`}
                    />
                  </div>
                );
              })}
            </div>

            <footer className="flex flex-wrap items-center justify-end gap-2 px-4 sm:px-5 py-3.5 border-t border-gray-100 bg-gray-50/70">
              <p className="flex-1 min-w-full sm:min-w-0 text-xs font-medium" role="status" aria-live="polite">
                {dirty ? (
                  <span className="inline-flex items-center gap-1.5 text-amber-600">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                    Unsaved changes — devices pick these up on their next sync
                  </span>
                ) : (
                  <span className="text-gray-400">
                    {data.enforcedDomains.toLocaleString()} domains enforced platform-wide
                  </span>
                )}
              </p>
              <button
                type="button"
                onClick={() => setCategories(policy.categories)}
                disabled={!dirty || saving}
                className="btn-ghost btn-sm min-h-[40px] px-3.5"
              >
                Discard changes
              </button>
              <button
                type="button"
                onClick={saveCategories}
                disabled={!dirty || saving}
                className="btn-primary btn-sm min-h-[40px] px-4"
              >
                <Icon name="check" size={16} strokeWidth={2.6} />
                {saving ? 'Saving…' : 'Save policy'}
              </button>
            </footer>
          </section>

          {/* ── The exceptions ──────────────────────────────────────────── */}
          <DataTable
            dense
            title="Domain rules"
            toolbar={
              /* The form belongs in the header rather than in a card of its
                 own: adding a rule is the reason to be looking at this list,
                 and a separate card below the table put the two furthest apart
                 at exactly the moment the list is empty. */
              <form onSubmit={addRule} className="flex flex-col sm:flex-row gap-2 w-full lg:w-auto">
                <label className="relative block flex-1 min-w-0 lg:w-64">
                  <span className="sr-only">Domain to add</span>
                  <span className="absolute inset-y-0 left-3 flex items-center text-gray-300" aria-hidden="true">
                    <Icon name="globe" size={16} />
                  </span>
                  <input
                    className="input pl-9 min-h-[40px] py-1.5 text-sm"
                    placeholder="example.com"
                    value={form.domain}
                    autoComplete="off"
                    spellCheck="false"
                    onChange={(e) => setForm({ ...form, domain: e.target.value })}
                  />
                </label>

                <select
                  className="input min-h-[40px] py-1.5 text-sm sm:w-44"
                  value={form.action}
                  aria-label="Rule type"
                  onChange={(e) => setForm({ ...form, action: e.target.value })}
                >
                  {RULE_ACTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>

                <button
                  type="submit"
                  disabled={adding || !form.domain.trim()}
                  className="btn-primary btn-sm min-h-[40px] px-3.5 shrink-0"
                >
                  <Icon name="plus" size={16} strokeWidth={2.4} />
                  {adding ? 'Adding…' : 'Add rule'}
                </button>
              </form>
            }
            columns={[
              {
                key: 'domain',
                header: 'Domain',
                primary: true,
                cell: (rule) => (
                  <span className="flex items-center gap-2 min-w-0">
                    <Icon name="globe" size={15} className="shrink-0 text-gray-300" />
                    <span className="text-sm font-medium text-gray-900 truncate">{rule.domain}</span>
                  </span>
                ),
              },
              {
                key: 'action',
                header: 'Rule type',
                cell: (rule) => (
                  <span className={rule.action === 'allow' ? 'badge-green' : 'badge-red'}>
                    {rule.action === 'allow' ? 'Allow' : 'Block'}
                  </span>
                ),
              },
              {
                key: 'addedBy',
                header: 'Added by',
                cell: (rule) => (
                  <span className="text-sm text-gray-600">
                    {rule.addedBy || 'System'}
                    <span className="block text-xs text-gray-400">{formatDate(rule.addedAt)}</span>
                  </span>
                ),
              },
            ]}
            rows={policy.domainRules}
            rowKey={(rule) => rule.domain}
            actions={(rule) => (
              <button
                type="button"
                onClick={() => removeRule(rule.domain)}
                className="btn-secondary btn-sm lg:w-9 lg:px-0 text-gray-500 hover:text-danger"
                aria-label={`Remove the rule for ${rule.domain}`}
                title={`Remove the rule for ${rule.domain}`}
              >
                <Icon name="trash" size={15} />
                <span className="lg:hidden">Remove</span>
              </button>
            )}
            empty={
              <EmptyState
                icon="globe"
                title="No domain rules yet"
                description="The categories above cover the common cases. Add a domain here for a site they miss, or to let one through."
              />
            }
          />
        </div>

        {/* ── What it covers, and what it caught ────────────────────────── */}
        <div className="space-y-5">
          <SideCard
            icon="shieldCheck"
            title="Enforcement"
            subtitle="Who this policy reaches, and what they have added to it."
          >
            <dl className="space-y-3">
              {[
                ['Children covered', summary.children, 'Every child profile on the platform'],
                ['Devices enforcing', summary.devices, 'Linked and active — the devices that fetch rules'],
                ['Domains in force', data.enforcedDomains, 'From the categories above and the rules below'],
                ['Family rules', summary.customDomains, `Domains parents blocked themselves · ${summary.allowances} allowed`],
              ].map(([label, value, hint]) => (
                <div key={label} className="flex items-start justify-between gap-3">
                  <dt className="min-w-0">
                    <span className="block text-sm text-gray-700">{label}</span>
                    <span className="block text-xs text-gray-400">{hint}</span>
                  </dt>
                  <dd className="text-lg font-bold text-gray-900 tabular-nums shrink-0">
                    {Number(value || 0).toLocaleString()}
                  </dd>
                </div>
              ))}
            </dl>

            <p className="notice-info mt-4 text-xs">
              <Icon name="info" size={16} className="shrink-0 mt-px" />
              <span>
                A device applies the policy on its next sync — within five minutes for a phone
                that is switched on. A parent can still allow a single site their family needs.
              </span>
            </p>
          </SideCard>

          <SideCard
            icon="reports"
            title="Top blocked categories"
            subtitle={`Attempts stopped on child devices, past ${windowDays} days`}
          >
            {attempts.total === 0 ? (
              <p className="text-sm text-gray-500">
                No blocked lookups have been reported in the last {windowDays} days. Devices report
                these as they browse, so a quiet week here means the rules were not tested — not
                that they are missing.
              </p>
            ) : (
              <>
                <p className="text-3xl font-bold text-gray-900 tabular-nums leading-none mb-4">
                  {attempts.total.toLocaleString()}
                  <span className="ml-2 text-xs font-medium text-gray-400 align-middle">attempts blocked</span>
                </p>
                <CategoryBars rows={attempts.byCategory} windowDays={windowDays} />

                {attempts.topDomains.length > 0 && (
                  <div className="mt-5 pt-4 border-t border-gray-100">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500 mb-2">
                      Most blocked domains
                    </p>
                    <ul className="space-y-1.5">
                      {attempts.topDomains.slice(0, 5).map((row) => (
                        <li key={row.domain} className="flex items-baseline justify-between gap-3">
                          <span className="text-sm text-gray-700 truncate">{row.domain}</span>
                          <span className="text-sm text-gray-500 tabular-nums shrink-0">
                            {row.attempts.toLocaleString()}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}

            <p className="text-xs text-gray-400 mt-4">
              Counted from the lookups devices report as blocked.{' '}
              <Link to="/audit-logs" className="text-primary-600 font-medium hover:underline">
                System logs
              </Link>{' '}
              record every change made to this policy.
            </p>
          </SideCard>
        </div>
      </div>
    </div>
  );
}
