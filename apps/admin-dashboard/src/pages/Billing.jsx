import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { admin as adminApi, errorMessage, EmptyState, Icon, Modal } from '@parentix/shared';
import DataTable from '../components/DataTable';
import StatTile from '../components/StatTile';

/**
 * Billing & Subscriptions — what the platform earns and every payment behind it.
 *
 * Three levels of zoom, the same shape the other console screens use: the tiles
 * say how the business is doing, the chart and the plan mix say where that comes
 * from, and the table says which payment did what. Everything is read from
 * `GET /admin/transactions`, whose summary is platform-wide and does not move
 * when the table below is filtered.
 *
 * What the screen deliberately does not have is a "new plan" button. The
 * catalogue is `services/api/src/config/plans.js` plus a Stripe price per tier —
 * a plan invented in the console would have no price to charge against, so the
 * plan card reports the catalogue as it stands and points at the one part of it
 * the console really can change (entitlements, on the Settings screen).
 */

const PAGE_SIZE = 25;

const STATUS = {
  succeeded: { label: 'Paid', badge: 'badge-green', dot: 'bg-success' },
  failed: { label: 'Failed', badge: 'badge-red', dot: 'bg-danger' },
  active: { label: 'Active', badge: 'badge-green', dot: 'bg-success' },
  past_due: { label: 'Past due', badge: 'badge-amber', dot: 'bg-warning' },
  cancelled: { label: 'Cancelled', badge: 'badge-gray', dot: 'bg-gray-400' },
};

const statusOf = (key) => STATUS[key] || { label: key, badge: 'badge-gray', dot: 'bg-gray-400' };

/** What the webhook writes, in words a finance operator uses. */
const TYPE_LABELS = {
  checkout_completed: 'New subscription',
  invoice_paid: 'Renewal',
  invoice_failed: 'Payment failed',
  subscription_updated: 'Plan changed',
  subscription_cancelled: 'Cancelled',
};

const typeLabel = (type) => TYPE_LABELS[type] || String(type || '').replace(/_/g, ' ');

/** The three windows the revenue chart offers, and the series each one reads. */
const RANGES = [
  { key: 'day', label: '1M', title: 'the last 30 days', tick: { month: 'short', day: 'numeric' } },
  { key: 'week', label: '3M', title: 'the last 12 weeks', tick: { month: 'short', day: 'numeric' } },
  { key: 'month', label: '1Y', title: 'the last 12 months', tick: { month: 'short' } },
];

// ── Money ────────────────────────────────────────────────────────────────────

/**
 * Cents to a currency string, in the currency the payments were actually taken
 * in. `Intl` is what knows that ¥ has no minor unit while $ has two, so the
 * amounts are handed over in whole units and the formatter decides the rest.
 */
const money = (cents, currency = 'usd', options = {}) => new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: (currency || 'usd').toUpperCase(),
  ...options,
}).format((cents || 0) / 100);

/** The same, shortened for an axis: $124.5K rather than $124,500.00. */
const compactMoney = (cents, currency) =>
  money(cents, currency, { notation: 'compact', maximumFractionDigits: 1 });

/** A transaction id is a UUID; finance quotes the front of it, not all 36. */
const invoiceRef = (id) => `INV-${String(id).slice(0, 8).toUpperCase()}`;

// ── Pieces of the screen ─────────────────────────────────────────────────────

/**
 * Revenue actually billed, by period, with the current period picked out.
 *
 * Recharts rather than a hand-drawn SVG — unlike the 40px sparklines on the
 * tiles, this one carries an axis, a scale and a tooltip, and the Overview
 * screen already puts the library in this app's bundle.
 */
function RevenueTrend({ summary, range, onRange }) {
  const active = RANGES.find((r) => r.key === range) || RANGES[0];

  const data = useMemo(() => (summary?.revenue?.[active.key] || []).map((bucket) => ({
    label: new Date(bucket.start).toLocaleDateString(undefined, active.tick),
    amount: bucket.amount,
  })), [summary, active]);

  const total = data.reduce((sum, d) => sum + d.amount, 0);
  // A 30-bucket axis cannot show 30 labels at any width a phone has; every
  // other one on the daily range, all of them on the coarser two.
  const tickInterval = data.length > 16 ? Math.ceil(data.length / 8) - 1 : 0;

  return (
    <div className="card p-4 sm:p-5 h-full flex flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="section-title">Revenue trend</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            {money(total, summary?.currency, { maximumFractionDigits: 0 })} billed over {active.title}
          </p>
        </div>

        {/* A segmented control, not three buttons: one group, one label, and the
            pressed state carried by aria-pressed rather than by colour alone. */}
        <div
          role="group"
          aria-label="Revenue range"
          className="flex items-center gap-0.5 p-0.5 rounded-xl bg-gray-100 shrink-0"
        >
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => onRange(r.key)}
              aria-pressed={r.key === range}
              title={`Revenue over ${r.title}`}
              className={`min-h-[36px] px-3.5 rounded-[10px] text-xs font-semibold transition-colors ${
                r.key === range
                  ? 'bg-white text-gray-900 shadow-card'
                  : 'text-gray-500 hover:text-gray-900'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* The chart takes whatever height the row settles on — this card sits
          beside the plan mix, and a fixed 240px leaves a band of empty card
          under it whenever the legend beside it happens to be taller. */}
      <div className="mt-4 flex-1 min-h-[240px]">
        {total === 0 ? (
          <p className="text-sm text-gray-400 py-16 text-center">
            No payments recorded over {active.title}.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 4, left: -12, bottom: 0 }}>
              <XAxis
                dataKey="label" axisLine={false} tickLine={false} interval={tickInterval}
                tick={{ fontSize: 11, fill: '#9ca3af' }}
              />
              <YAxis
                axisLine={false} tickLine={false} width={56}
                tick={{ fontSize: 11, fill: '#9ca3af' }}
                tickFormatter={(value) => compactMoney(value, summary?.currency)}
              />
              <Tooltip
                cursor={{ fill: '#f3f4f6' }}
                contentStyle={{ borderRadius: 12, border: '1px solid #f3f4f6', fontSize: 12 }}
                formatter={(value) => [money(value, summary?.currency), 'Billed']}
              />
              <Bar dataKey="amount" radius={[6, 6, 0, 0]} maxBarSize={44}>
                {data.map((entry, i) => (
                  <Cell
                    // Positional by nature — these are periods, not identified things.
                    // eslint-disable-next-line react/no-array-index-key
                    key={i}
                    fill={i === data.length - 1 ? '#0b2451' : '#c2d4f0'}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

/**
 * The plan mix as a ring, and the catalogue it is drawn from.
 *
 * Hand-drawn with two SVG circles rather than handed to Recharts: a ring of two
 * or three segments is `stroke-dasharray` arithmetic, and doing it here is what
 * lets the total sit crisply in the middle instead of inside a chart layer.
 */
function PlanDistribution({ summary }) {
  const plans = summary?.plans || [];
  const total = plans.reduce((sum, p) => sum + p.subscribers, 0);

  /**
   * The tiers that pay take the dark end of the ramp and the ones that do not
   * take the light end, so the ring reads as revenue at a glance rather than as
   * whichever plan the catalogue happens to list first. Resolved from the plan's
   * own key — never from its place among the drawn segments — so a tier with no
   * subscribers cannot shift the colours out from under the legend.
   */
  const PAID_RAMP = ['#0b2451', '#2563eb'];
  const FREE_RAMP = ['#93b4e0', '#cbd5e1'];
  const ramp = new Map();
  plans.forEach((plan) => {
    const pool = plan.paid ? PAID_RAMP : FREE_RAMP;
    const taken = [...ramp.values()].filter((c) => pool.includes(c)).length;
    ramp.set(plan.key, pool[taken % pool.length]);
  });
  const colourOf = (plan) => ramp.get(plan.key) || '#cbd5e1';

  // A 100-unit circumference makes each segment's dash length its percentage,
  // and each segment's offset the sum of the shares drawn before it.
  const RADIUS = 100 / (2 * Math.PI);
  const segments = [];
  let drawn = 0;
  plans.forEach((plan) => {
    if (!plan.subscribers || !total) return;
    const share = (plan.subscribers / total) * 100;
    segments.push({ key: plan.key, share, offset: drawn, colour: colourOf(plan) });
    drawn += share;
  });

  return (
    <div className="card p-4 sm:p-5 h-full flex flex-col">
      <div className="flex items-center justify-between gap-3">
        <h2 className="section-title">Plan distribution</h2>
        <Icon name="card" size={17} className="text-gray-400" />
      </div>

      {total === 0 ? (
        <p className="mt-6 text-sm text-gray-400">No customer accounts yet.</p>
      ) : (
        <>
          <div className="relative mt-5 mx-auto w-40 h-40 sm:w-44 sm:h-44">
            <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90" aria-hidden="true" focusable="false">
              <circle cx="18" cy="18" r={RADIUS} fill="none" stroke="#f1f5f9" strokeWidth="4.2" />
              {segments.map((seg) => (
                <circle
                  key={seg.key}
                  cx="18" cy="18" r={RADIUS}
                  fill="none"
                  stroke={seg.colour}
                  strokeWidth="4.2"
                  strokeDasharray={`${seg.share} ${100 - seg.share}`}
                  strokeDashoffset={-seg.offset}
                  strokeLinecap="butt"
                />
              ))}
            </svg>

            <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
              <span className="text-2xl sm:text-3xl font-bold tracking-tight text-gray-900 tabular-nums">
                {total.toLocaleString()}
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400">
                Accounts
              </span>
            </div>
          </div>

          <dl className="mt-5 space-y-3">
            {plans.map((plan) => (
              <div key={plan.key}>
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <dt className="flex items-center gap-2 min-w-0 text-gray-700 font-medium">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: colourOf(plan) }}
                    />
                    <span className="truncate">{plan.label}</span>
                  </dt>
                  <dd className="shrink-0 tabular-nums text-gray-500">
                    {plan.subscribers.toLocaleString()} · {plan.share}%
                  </dd>
                </div>
                <p className="mt-1 pl-[1.125rem] text-[11px] text-gray-400">
                  {plan.paid
                    ? `${money(plan.amount, summary.currency)} / month · ${money(plan.mrr, summary.currency, { maximumFractionDigits: 0 })} of the run rate`
                    : 'No charge'}
                </p>
              </div>
            ))}
          </dl>

          <p className="mt-auto pt-4 text-[11px] leading-relaxed text-gray-400 border-t border-gray-100">
            Prices come from the plan catalogue and its Stripe prices. What each tier unlocks is
            edited on the Settings screen.
          </p>
        </>
      )}
    </div>
  );
}

/** A labelled line in the payment dialog. */
function Field({ label, children }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400">{label}</dt>
      <dd className="mt-0.5 text-sm text-gray-900 break-words">{children}</dd>
    </div>
  );
}

// ── The screen ───────────────────────────────────────────────────────────────

export default function AdminBilling() {
  const [rows, setRows] = useState([]);
  const [count, setCount] = useState(0);
  const [summary, setSummary] = useState(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [range, setRange] = useState('month');
  const [detail, setDetail] = useState(null);

  // As on the directory and the fleet: `search` is what is typed, `appliedSearch`
  // is what the last submit asked for, so a keystroke never fires a request.
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [filters, setFilters] = useState({ status: '', plan: '' });

  const query = useCallback((extra = {}) => ({
    search: appliedSearch || undefined,
    status: filters.status || undefined,
    plan: filters.plan || undefined,
    ...extra,
  }), [appliedSearch, filters]);

  const load = useCallback(() => {
    setLoading(true);
    return adminApi.listTransactions(query({ limit: PAGE_SIZE, offset }))
      .then((r) => {
        setRows(r.data.rows);
        setCount(r.data.count);
        setSummary(r.data.summary);
      })
      .catch((e) => setError(errorMessage(e, 'Failed to load billing')))
      .finally(() => setLoading(false));
  }, [offset, query]);

  useEffect(() => { load(); }, [load]);

  // A narrower filter or search can leave the offset past the end of the results.
  const submitSearch = (event) => {
    event.preventDefault();
    setOffset(0);
    setAppliedSearch(search.trim());
  };
  const setFilter = (key, value) => {
    setOffset(0);
    setFilters((f) => ({ ...f, [key]: value }));
  };

  const currency = summary?.currency || 'usd';

  /**
   * The filtered payment log as a spreadsheet — the one thing a finance operator
   * asks for that a screen cannot give them. It re-fetches rather than exporting
   * the 25 rows on screen, because an "export" that means "export this page" is
   * a trap.
   */
  const exportCsv = async () => {
    setExporting(true);
    try {
      const { data } = await adminApi.listTransactions(query({ limit: 200, offset: 0 }));
      const header = ['Reference', 'Transaction ID', 'Date', 'Customer', 'Email', 'Type', 'Plan', 'Amount', 'Currency', 'Status'];
      const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
      const csv = [
        header.map(cell).join(','),
        ...data.rows.map((t) => [
          invoiceRef(t.id), t.id,
          t.createdAt ? new Date(t.createdAt).toISOString() : '',
          t.user?.name || '', t.user?.email || '',
          typeLabel(t.type), t.plan || '',
          t.amount != null ? (t.amount / 100).toFixed(2) : '',
          (t.currency || '').toUpperCase(),
          statusOf(t.status).label,
        ].map(cell).join(',')),
      ].join('\n');

      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `parentix-billing-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);

      if (data.count > data.rows.length) {
        setError(`Exported the first ${data.rows.length} of ${data.count} payments. Narrow the filters for the rest.`);
      }
    } catch (e) {
      setError(errorMessage(e, 'Failed to export the payment log'));
    } finally {
      setExporting(false);
    }
  };

  const columns = [
    {
      key: 'invoice',
      header: 'Reference',
      primary: true,
      // Capped rather than merely truncated: an auto-layout table takes its
      // width from its content, so one long value in any column widens it and
      // pushes the row actions into a scroller instead of shortening itself.
      cell: (t) => (
        <span className="block min-w-0 lg:max-w-[9rem]">
          {/* The row's own keyboard path to the detail dialog. Held at a 40px
              target and pulled back by most of it, so it stays tappable on a
              phone without the reference floating away from the line under it —
              a monospaced 13px line is short enough that padding alone lands
              just under the 36px a thumb needs. */}
          <button
            type="button"
            onClick={() => setDetail(t)}
            className="block max-w-full truncate text-left font-semibold text-gray-900 font-mono text-[13px]
                       hover:text-primary-700 rounded min-h-[40px] py-2.5 -my-2"
          >
            {invoiceRef(t.id)}
          </button>
          {/* The plan rides here rather than taking a seventh column: six
              columns and an action already fill a 1280px console screen. */}
          <span className="block text-xs text-gray-400 truncate">
            {typeLabel(t.type)}
            {t.plan ? <span className="capitalize"> · {t.plan}</span> : null}
          </span>
        </span>
      ),
    },
    {
      key: 'date',
      header: 'Date',
      cell: (t) => (
        <span className="block min-w-0 lg:max-w-[8rem]">
          <span className="block text-sm text-gray-700 truncate">
            {t.createdAt ? new Date(t.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
          </span>
          <span className="block text-xs text-gray-400 truncate">
            {t.createdAt ? new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
          </span>
        </span>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      cell: (t) => (
        // Capped rather than merely truncated: an auto-layout table takes its
        // width from its content, so a long email would widen this column and
        // push the actions into a scroller instead of shortening itself.
        <span className="block min-w-0 lg:max-w-[11rem] 2xl:max-w-[16rem]">
          <span className="block text-sm font-medium text-gray-900 truncate">{t.user?.name || 'Deleted account'}</span>
          <span className="block text-xs text-gray-400 truncate">{t.user?.email || '—'}</span>
        </span>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      cell: (t) => (
        <span className={`text-sm font-semibold tabular-nums ${t.amount ? 'text-gray-900' : 'text-gray-300'}`}>
          {t.amount != null ? money(t.amount, t.currency) : '—'}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (t) => {
        const status = statusOf(t.status);
        return (
          <span className={`${status.badge} gap-1.5`}>
            <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
            {status.label}
          </span>
        );
      },
    },
  ];

  /**
   * The reference design puts a download beside every invoice. Nothing here can
   * honour that — Stripe hosts the PDF and the platform stores neither the file
   * nor the link to it — so the row action opens the record the console does
   * hold, and the whole filtered log downloads from the header instead.
   */
  const actions = (t) => (
    <button
      type="button"
      onClick={() => setDetail(t)}
      aria-label={`Payment details for ${invoiceRef(t.id)}`}
      title="Payment details"
      className="btn-secondary btn-sm lg:w-9 lg:px-0"
    >
      <Icon name="chevronRight" size={15} strokeWidth={2.2} />
      <span className="lg:hidden">Details</span>
    </button>
  );

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
      <form onSubmit={submitSearch} className="relative flex-1 min-w-[10rem] sm:w-56 sm:flex-none">
        <Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Customer, email or type…"
          aria-label="Search payments"
          className="input pl-9 sm:min-h-[38px] sm:py-1.5 sm:text-xs"
        />
      </form>

      <select
        className="input w-auto sm:min-h-[38px] sm:py-1.5 sm:text-xs"
        value={filters.status} aria-label="Filter by status"
        onChange={(e) => setFilter('status', e.target.value)}
      >
        <option value="">All statuses</option>
        <option value="succeeded">Paid</option>
        <option value="failed">Failed</option>
        <option value="active">Active</option>
        <option value="past_due">Past due</option>
        <option value="cancelled">Cancelled</option>
      </select>

      <select
        className="input w-auto sm:min-h-[38px] sm:py-1.5 sm:text-xs"
        value={filters.plan} aria-label="Filter by plan"
        onChange={(e) => setFilter('plan', e.target.value)}
      >
        <option value="">All plans</option>
        <option value="free">Free</option>
        <option value="premium">Premium</option>
      </select>
    </div>
  );

  const filtered = !!(appliedSearch || filters.status || filters.plan);

  return (
    <div className="space-y-4 sm:space-y-5">
      {/* What the screen is for, and the two things it can do about it. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-gray-500 max-w-xl">
          Revenue, subscriptions and every payment Stripe has reported — what the platform earns
          each month, which tier it comes from, and which charges did not go through.
        </p>
        <div className="flex items-center gap-2">
          <button type="button" onClick={load} disabled={loading} className="btn-secondary btn-sm">
            <Icon name="refresh" size={15} />
            Refresh
          </button>
          <button type="button" onClick={exportCsv} disabled={exporting || loading} className="btn-primary btn-sm">
            <Icon name="download" size={15} />
            {exporting ? 'Exporting…' : 'Export report'}
          </button>
        </div>
      </div>

      {error && (
        <p className="notice-error">
          <Icon name="warning" size={16} className="mt-0.5" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError('')} aria-label="Dismiss" className="shrink-0">
            <Icon name="close" size={16} />
          </button>
        </p>
      )}

      {/* The business at a glance. Unaffected by the filters below. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
        {/* A tile label is held to one line so four of them are one height, and
            four across a 1280px console leaves room for about twenty characters
            — which "Monthly recurring revenue" is not. */}
        <StatTile
          label="Recurring revenue"
          value={summary ? money(summary.mrr, currency, { maximumFractionDigits: 0 }) : '—'}
          unit="per month"
          icon="card"
          delta={summary ? summary.mrrChange : null}
          deltaLabel="Current run rate against what was billed over the previous 30 days"
        />
        <StatTile
          label="Active subscribers"
          value={summary ? summary.subscribers.toLocaleString() : '—'}
          unit={summary ? `of ${summary.customers.toLocaleString()} accounts` : ''}
          icon="children"
          delta={summary ? summary.subscriberChange : null}
          deltaLabel="Against the subscriber base 30 days ago"
        />
        <StatTile
          label="Churn rate"
          value={summary && summary.churn.rate !== null ? `${summary.churn.rate}%` : '—'}
          unit={summary ? `${summary.churn.cancellations} cancelled` : ''}
          icon="userMinus"
          goodWhenUp={false}
          delta={summary && summary.churn.rate !== null && summary.churn.previousRate !== null
            ? Math.round((summary.churn.rate - summary.churn.previousRate) * 10) / 10
            : null}
          deltaLabel="Percentage points against the 30 days before that"
          alert={!!summary && summary.churn.rate !== null && summary.churn.rate >= 10}
        />
        <StatTile
          label="Avg rev per user"
          value={summary ? money(summary.arpu, currency) : '—'}
          unit="per subscription"
          icon="reports"
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 sm:gap-5 items-stretch">
        <div className="xl:col-span-2">
          <RevenueTrend summary={summary} range={range} onRange={setRange} />
        </div>
        <PlanDistribution summary={summary} />
      </div>

      {/* Failed charges are money the platform expected and did not get, so they
          are worth calling out rather than leaving to be found by filtering. */}
      {summary && summary.failedPayments > 0 && (
        <p className="notice-warning">
          <Icon name="warning" size={16} className="mt-0.5" />
          <span className="flex-1">
            {summary.failedPayments} payment{summary.failedPayments === 1 ? '' : 's'} failed in the last
            30 days. Stripe retries them on its own schedule; the accounts sit as past due until one lands.
          </span>
          <button
            type="button"
            onClick={() => { setOffset(0); setFilters((f) => ({ ...f, status: 'failed' })); }}
            className="btn-ghost btn-sm shrink-0 text-amber-900"
          >
            Show them
          </button>
        </p>
      )}

      <DataTable
        dense
        title={`Payments (${count.toLocaleString()})`}
        toolbar={toolbar}
        columns={columns}
        rows={rows}
        rowKey={(t) => t.id}
        actions={actions}
        loading={loading}
        loadingLabel="Loading payments…"
        empty={(
          <EmptyState
            icon="card"
            title={filtered ? 'No payments match' : 'No payments yet'}
            description={filtered
              ? 'Clear the filters to see the whole log.'
              : 'Payments appear here once customers start subscribing.'}
          />
        )}
        pagination={{ offset, limit: PAGE_SIZE, count, onChange: setOffset, disabled: loading, label: 'payments' }}
      />

      {/* ── One payment, in full ───────────────────────────────────────────── */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail ? invoiceRef(detail.id) : ''}
        description={detail ? `${typeLabel(detail.type)} · ${statusOf(detail.status).label}` : undefined}
      >
        {detail && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
            <Field label="Amount">
              {detail.amount != null ? money(detail.amount, detail.currency) : 'No charge'}
            </Field>
            <Field label="Plan">
              <span className="capitalize">{detail.plan || '—'}</span>
            </Field>
            <Field label="Customer">
              <span className="block truncate">{detail.user?.name || 'Deleted account'}</span>
              <span className="block text-xs text-gray-500 truncate">{detail.user?.email || ''}</span>
            </Field>
            <Field label="Recorded">
              {detail.createdAt ? new Date(detail.createdAt).toLocaleString() : '—'}
            </Field>
            <div className="col-span-2">
              <Field label="Transaction ID">
                <span className="font-mono text-xs">{detail.id}</span>
              </Field>
            </div>
            {detail.stripeEventId && (
              <div className="col-span-2">
                <Field label="Stripe event">
                  <span className="font-mono text-xs">{detail.stripeEventId}</span>
                </Field>
              </div>
            )}
            <p className="col-span-2 text-[11px] leading-relaxed text-gray-400 border-t border-gray-100 pt-3">
              Receipts and invoice PDFs are held by Stripe. This is the record the platform keeps of
              what its webhook was told.
            </p>
          </dl>
        )}
      </Modal>
    </div>
  );
}
