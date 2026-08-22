import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import {
  admin as adminApi, errorMessage, timeAgo, EmptyState, Icon, StatsCard, Toggle,
  useAuth, hasPermission, PERMISSIONS,
} from '@parentix/shared';
import DataTable from '../components/DataTable';

/**
 * Overview — what the platform is doing right now, and how it is growing.
 *
 * The screen opens on the part an operator is on it for: anything critical, the
 * severity mix behind it, what the platform can raise and where it goes. The
 * growth charts are below that, unchanged — they answer a question nobody asks
 * before the alerts are dealt with.
 *
 * Everything in the alert panel is counted from the audit stream, by the same
 * severity rules the System Logs screen filters with, so a tile here and the
 * screen it links to always agree. There is no metrics pipeline behind Parentix —
 * no CPU, no latency, no error rate — so the reference design's "CPU > 90% for
 * 5m" rule has nothing to read. What the platform does have is a fixed set of
 * alerts with real producers, and one honest control over them: an operator can
 * hold a type back from email and push when it is flooding. The alert is still
 * recorded and still reaches the parent's dashboard; only the notification stops.
 *
 * The panel needs `view_audit_logs`. An account without it sees the analytics
 * alone rather than a permission error.
 */

const COLORS = ['#2563eb', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

const TOOLTIP_STYLE = { borderRadius: 12, border: '1px solid #f3f4f6', fontSize: 12 };

/** How each severity reads: the tile, the dot beside a history row, its icon. */
const LEVELS = {
  critical: { label: 'Critical', icon: 'warning', tile: 'bg-red-50 text-red-700 border-red-100', dot: 'bg-danger', badge: 'badge-red' },
  error: { label: 'Errors', icon: 'block', tile: 'bg-orange-50 text-orange-700 border-orange-100', dot: 'bg-orange-500', badge: 'badge-amber' },
  warning: { label: 'Warnings', icon: 'info', tile: 'bg-amber-50 text-amber-700 border-amber-100', dot: 'bg-warning', badge: 'badge-amber' },
  info: { label: 'Info', icon: 'file', tile: 'bg-blue-50 text-blue-700 border-blue-100', dot: 'bg-primary-500', badge: 'badge-blue' },
};

const CHANNEL_ICONS = { email: 'mail', push: 'bell', sms: 'message' };

const CHANNEL_STATUS = {
  active: { label: 'Active', badge: 'badge-green' },
  inactive: { label: 'Not configured', badge: 'badge-amber' },
  unavailable: { label: 'Not integrated', badge: 'badge-gray' },
};

/** An action name as a sentence: `admin.user_deleted` → "Admin · user deleted". */
const actionText = (action) => String(action || '')
  .replace('.', ' · ')
  .replace(/_/g, ' ')
  .replace(/^./, (c) => c.toUpperCase());

/**
 * The banner for the newest critical entry.
 *
 * A critical entry is an account deletion or a lockout — something already done
 * that somebody should know about, not a fault to be repaired. So the banner
 * offers exactly what the console can honour: a record that a human has seen it,
 * and the entry itself.
 */
function CriticalBanner({ critical, onAcknowledge, acknowledging }) {
  const { entry, acknowledged, acknowledgedBy } = critical;

  return (
    <section
      className={`rounded-2xl border p-4 sm:p-5 ${
        acknowledged ? 'border-gray-200 bg-white' : 'border-red-200 bg-red-50'
      }`}
      aria-labelledby="critical-heading"
    >
      <div className="flex flex-col sm:flex-row sm:items-start gap-3 sm:gap-4">
        <span
          className={`flex items-center justify-center w-10 h-10 shrink-0 rounded-xl ${
            acknowledged ? 'bg-gray-100 text-gray-400' : 'bg-white text-danger'
          }`}
          aria-hidden="true"
        >
          <Icon name={acknowledged ? 'check' : 'warning'} size={21} />
        </span>

        <div className="min-w-0 flex-1">
          <h2
            id="critical-heading"
            className={`text-base sm:text-lg font-bold ${acknowledged ? 'text-gray-900' : 'text-red-800'}`}
          >
            {acknowledged ? 'Critical entry acknowledged' : 'Critical system entry'}
          </h2>
          <p className={`text-sm mt-1 ${acknowledged ? 'text-gray-600' : 'text-red-700'}`}>
            {actionText(entry.action)}
            {entry.actor ? ` by ${entry.actor.name}` : ''} · {timeAgo(entry.createdAt)}
            {acknowledged && acknowledgedBy ? ` · seen by ${acknowledgedBy}` : ''}
          </p>
        </div>

        <div className="flex flex-wrap gap-2 shrink-0">
          {!acknowledged && (
            <button
              type="button"
              onClick={() => onAcknowledge(entry.id)}
              disabled={acknowledging}
              className="btn-danger btn-sm min-h-[40px] px-4"
            >
              {acknowledging ? 'Saving…' : 'Acknowledge'}
            </button>
          )}
          <Link
            to="/audit-logs?level=critical&range=7d"
            className="btn-secondary btn-sm min-h-[40px] px-4"
          >
            View details
          </Link>
        </div>
      </div>
    </section>
  );
}

/**
 * The alert detail: what the platform can raise, where it goes, and what it has
 * been saying.
 *
 * It sits at the foot of the screen, below the growth charts. The summary tiles
 * above are the part an operator reads on arrival — a count, and a link into the
 * entries behind it — and this is the reference material they open when one of
 * those counts is wrong.
 */
function AlertDetails({ health, mayMute, onToggleMute }) {
  return (
    <div className="grid xl:grid-cols-3 gap-5 items-start">
      {/* The alert catalogue, and the one thing about it that is editable. */}
      <div className="xl:col-span-2">
        <DataTable
          dense
          title="Alert types"
          toolbar={
            <p className="text-xs text-gray-500 w-full sm:w-auto sm:text-right sm:max-w-xs">
              Every alert the platform can raise. Muting one holds back its email and push —
              the alert is still recorded and still shown to the parent.
            </p>
          }
          columns={[
            {
              key: 'label',
              header: 'Alert',
              primary: true,
              cell: (type) => (
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      !type.available ? 'bg-gray-200' : type.muted ? 'bg-gray-300' : 'bg-danger'
                    }`}
                    aria-hidden="true"
                  />
                  <span className={`text-sm font-medium truncate ${type.available ? 'text-gray-900' : 'text-gray-400'}`}>
                    {type.label}
                  </span>
                </span>
              ),
            },
            {
              key: 'condition',
              header: 'Condition',
              cell: (type) => <span className="text-sm text-gray-600">{type.condition}</span>,
            },
            {
              key: 'severity',
              header: 'Severity',
              cell: (type) => (
                <span className={type.severity === 'high' ? 'badge-red' : 'badge-amber'}>
                  {type.severity === 'high' ? 'High' : 'Medium'}
                </span>
              ),
            },
            {
              key: 'delivery',
              header: 'Delivery',
              align: 'right',
              /**
               * A rule with no producer gets no switch.
               *
               * Three of these describe a condition nothing in the product can
               * currently detect — the device has no call or SMS visibility, no
               * content classifier and no package-added receiver — so their rows
               * offered an operator a control over an alert that cannot be
               * raised. Saying so beats a toggle that does nothing, and it is
               * the honest answer to "what can this platform actually tell me?".
               * See config/alertTypes.js.
               */
              cell: (type) => (type.available ? (
                <span className="inline-flex items-center justify-end gap-2">
                  <span className="text-xs text-gray-500 whitespace-nowrap">
                    {type.muted ? 'Muted' : 'Email · push'}
                  </span>
                  <Toggle
                    checked={!type.muted}
                    disabled={!mayMute}
                    onChange={() => onToggleMute(type.key)}
                    size="sm"
                    aria-label={`${type.muted ? 'Resume' : 'Hold back'} email and push for ${type.label}`}
                  />
                </span>
              ) : (
                <span
                  className="badge-gray whitespace-nowrap"
                  title="No part of the product raises this yet, so there is nothing to hold back."
                >
                  Not raised yet
                </span>
              )),
            },
          ]}
          rows={health.alertTypes}
          rowKey={(type) => type.key}
        />
      </div>

      <div className="space-y-5">
        {/* Where an alert can actually go. */}
        <section className="card p-4 sm:p-5">
          <h2 className="section-title">Delivery channels</h2>
          <p className="text-xs text-gray-500 mt-0.5">How an alert leaves the platform.</p>

          <ul className="space-y-2 mt-4">
            {health.channels.map((channel) => {
              const status = CHANNEL_STATUS[channel.status] || CHANNEL_STATUS.unavailable;
              return (
                <li
                  key={channel.key}
                  className={`flex items-start gap-3 px-3.5 py-3 rounded-xl border ${
                    channel.status === 'active' ? 'border-gray-200' : 'border-gray-100 bg-gray-50/60'
                  }`}
                >
                  <span
                    className={`flex items-center justify-center w-9 h-9 shrink-0 rounded-lg ${
                      channel.status === 'active' ? 'bg-primary-50 text-primary-600' : 'bg-gray-100 text-gray-400'
                    }`}
                    aria-hidden="true"
                  >
                    <Icon name={CHANNEL_ICONS[channel.key] || 'bell'} size={17} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-gray-900">{channel.label}</span>
                      <span className={`${status.badge} shrink-0`}>{status.label}</span>
                    </span>
                    {/* Wrapped, not truncated: "No VAPID keypair configured"
                        cut to "No VAPID …" tells an operator nothing. */}
                    <span className="block text-xs text-gray-500 mt-0.5 break-words">
                      {channel.detail}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        {/* What happened, most recent first. */}
        <section className="card p-4 sm:p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="section-title">Recent history</h2>
            <Link to="/audit-logs" className="text-xs font-semibold text-primary-600 hover:underline shrink-0">
              View all logs
            </Link>
          </div>

          {health.recent.length === 0 ? (
            <p className="text-sm text-gray-500 mt-4">
              Nothing above routine activity in {health.windowLabel.toLowerCase()}.
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {health.recent.map((entry) => {
                const meta = LEVELS[entry.level] || LEVELS.info;
                return (
                  <li key={entry.id} className="flex gap-2.5">
                    <span className={`w-2 h-2 rounded-full shrink-0 mt-1.5 ${meta.dot}`} aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-gray-900 truncate">
                        {actionText(entry.action)}
                      </span>
                      <span className="block text-xs text-gray-500 truncate">
                        {timeAgo(entry.createdAt)}
                        {entry.actor ? ` · ${entry.actor.name}` : ''}
                        {` · ${meta.label.replace(/s$/, '')}`}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

export default function AdminOverview() {
  const { user } = useAuth();
  const mayReadLogs = hasPermission(user, PERMISSIONS.VIEW_AUDIT_LOGS);
  const mayMute = hasPermission(user, PERMISSIONS.MANAGE_SETTINGS);

  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const [health, setHealth] = useState(null);
  const [healthWindow, setHealthWindow] = useState('24h');
  const [acknowledging, setAcknowledging] = useState(false);
  const [healthError, setHealthError] = useState('');

  useEffect(() => {
    adminApi.getAnalytics()
      .then((r) => setData(r.data))
      .catch((e) => setError(errorMessage(e, 'Failed to load analytics')));
  }, []);

  const loadHealth = useCallback((window) => {
    if (!mayReadLogs) return;
    adminApi.getPlatformHealth({ window })
      .then((r) => setHealth(r.data))
      .catch((e) => setHealthError(errorMessage(e, 'Failed to load the alert summary')));
  }, [mayReadLogs]);

  useEffect(() => { loadHealth(healthWindow); }, [loadHealth, healthWindow]);

  const acknowledge = async (entryId) => {
    setAcknowledging(true);
    setHealthError('');
    try {
      await adminApi.acknowledgeCritical(entryId);
      loadHealth(healthWindow);
    } catch (e) { setHealthError(errorMessage(e, 'Could not acknowledge that entry')); }
    finally { setAcknowledging(false); }
  };

  const toggleMute = async (key) => {
    const muted = health.alertTypes.filter((t) => t.muted).map((t) => t.key);
    const next = muted.includes(key) ? muted.filter((k) => k !== key) : [...muted, key];

    // Moved in the UI first: the switch is the control, and waiting a round trip
    // to show what it did makes it feel broken.
    setHealth((h) => ({
      ...h,
      alertTypes: h.alertTypes.map((t) => (t.key === key ? { ...t, muted: !t.muted } : t)),
    }));
    setHealthError('');

    try {
      await adminApi.updateAlertDelivery(next);
    } catch (e) {
      setHealthError(errorMessage(e, 'Could not change that alert'));
      loadHealth(healthWindow);
    }
  };

  if (error) {
    return (
      <div className="card">
        <EmptyState
          icon="warning"
          title="Could not load analytics"
          description={error}
          action={<button onClick={() => window.location.reload()} className="btn-primary">Try again</button>}
        />
      </div>
    );
  }
  if (!data) return <p className="text-sm text-gray-400 py-8">Loading analytics…</p>;

  const signupData = Object.entries(data.signupsByDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date: date.slice(5), count }));

  const signupTotal = signupData.reduce((s, d) => s + d.count, 0);

  return (
    <div className="space-y-5">
      {healthError && <p className="notice-error">{healthError}</p>}

      {health?.critical && (
        <CriticalBanner critical={health.critical} onAcknowledge={acknowledge} acknowledging={acknowledging} />
      )}

      {/* ── What the platform has been saying ─────────────────────────────── */}
      {mayReadLogs && health && (
        <>
          <section className="card p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="section-title">Activity summary</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  Recorded actions by severity, and the alerts raised to families in the same window.
                </p>
              </div>

              <label className="shrink-0">
                <span className="sr-only">Summary window</span>
                <select
                  className="input min-h-[40px] py-1.5 text-sm w-auto"
                  value={healthWindow}
                  onChange={(e) => setHealthWindow(e.target.value)}
                >
                  {health.windows.map((w) => (
                    <option key={w.value} value={w.value}>{w.label}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-4">
              {health.levels.map(({ level, count }) => {
                const meta = LEVELS[level] || LEVELS.info;
                return (
                  <Link
                    key={level}
                    // The window travels with the level, so the screen behind
                    // the tile counts the same entries the tile does.
                    to={`/audit-logs?level=${level}&range=${health.window}`}
                    className={`block rounded-xl border p-3.5 transition hover:shadow-card ${meta.tile}`}
                  >
                    <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em]">
                      <Icon name={meta.icon} size={14} strokeWidth={2.4} />
                      {meta.label}
                    </span>
                    <span className="block text-2xl sm:text-3xl font-bold mt-1.5 tabular-nums">
                      {count.toLocaleString()}
                    </span>
                  </Link>
                );
              })}
            </div>

            <p className="text-xs text-gray-400 mt-3">
              {health.familyAlerts.toLocaleString()} family {health.familyAlerts === 1 ? 'alert was' : 'alerts were'}
              {' '}raised on child devices in the same window. These counts are the platform&apos;s own record of
              what it did — Parentix has no infrastructure monitor behind them.
            </p>
          </section>
        </>
      )}

      {/* ── How the platform is growing ───────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-4">
        <StatsCard icon="children" title="Total users" value={data.totalUsers} color="blue" />
        <StatsCard icon="lock" title="Active sessions" value={data.activeSessions} color="green" />
        <StatsCard icon="card" title="Total revenue" value={`$${data.totalRevenue.toFixed(2)}`} color="purple" />
        <StatsCard icon="shieldCheck" title="MFA adoption" value={`${data.mfaAdoptionRate}%`} color="amber" />
        <StatsCard icon="sparkle" title="Signups" subtitle="Last 30 days" value={signupTotal} color="red" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-5">
        <div className="card">
          <h2 className="section-title mb-4">Signups (last 30 days)</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={signupData} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
              <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9ca3af' }} />
              <YAxis
                axisLine={false} tickLine={false} allowDecimals={false} width={40}
                tick={{ fontSize: 11, fill: '#9ca3af' }}
              />
              <Tooltip cursor={{ fill: '#f3f4f6' }} contentStyle={TOOLTIP_STYLE} />
              <Bar dataKey="count" fill="#2563eb" radius={[6, 6, 0, 0]} maxBarSize={32} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <h2 className="section-title mb-4">Users by plan</h2>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={data.byPlan} dataKey="count" nameKey="plan"
                cx="50%" cy="45%" outerRadius="75%" innerRadius="45%" paddingAngle={2}
              >
                {data.byPlan.map((entry, i) => <Cell key={entry.plan} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── The alerts in full, under the growth charts ────────────────────── */}
      {mayReadLogs && health && (
        <AlertDetails health={health} mayMute={mayMute} onToggleMute={toggleMute} />
      )}
    </div>
  );
}
