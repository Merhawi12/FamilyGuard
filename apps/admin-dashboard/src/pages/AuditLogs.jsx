import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { admin as adminApi, errorMessage, EmptyState, Icon, Toggle } from '@parentix/shared';
import DataTable from '../components/DataTable';

/**
 * System Logs — everything the platform has recorded about itself.
 *
 * One stream, four ways of narrowing it: free text, severity, service and a time
 * window. All four are query parameters rather than filters applied to the rows
 * on screen, because the count under the table and the paginator beside it have
 * to describe the same set the filters do — a level chosen in the browser would
 * leave "Showing 1–50 of 12,480" talking about a stream nobody is looking at.
 *
 * Neither the level nor the service is stored. Both are derived from the action
 * name (`auth.login_failed` → error, from auth) by `services/api/src/utils/
 * logSeverity.js`, which is also what builds the level filter's SQL, so a row's
 * badge and the filter that finds it can never disagree.
 *
 * Live tail polls. There is no log socket — the entries are written by whichever
 * request happened to cause them, on any instance — so the honest version of a
 * live stream is a refetch of the newest page every few seconds, paused when the
 * tab is in the background and turned off the moment you page away from the top
 * of the stream, where "live" would mean nothing.
 */

const PAGE_SIZE = 50;
const TAIL_INTERVAL_MS = 5000;
const SEARCH_DEBOUNCE_MS = 350;

/**
 * How each level is drawn. `row` is the tint down the table — reserved for the
 * two levels that want your attention, since a stripe on every row is wallpaper.
 */
const LEVELS = {
  critical: {
    label: 'Critical',
    badge: 'bg-danger text-white',
    row: 'bg-red-50/70',
    message: 'text-red-800',
    detail: 'text-red-600',
  },
  error: {
    label: 'Error',
    badge: 'bg-red-100 text-red-700',
    row: 'bg-red-50/30',
    message: 'text-gray-900',
    detail: 'text-red-600',
  },
  warning: {
    label: 'Warn',
    badge: 'bg-amber-100 text-amber-800',
    row: '',
    message: 'text-gray-900',
    detail: 'text-gray-400',
  },
  info: {
    label: 'Info',
    badge: 'bg-primary-50 text-primary-700',
    row: '',
    message: 'text-gray-900',
    detail: 'text-gray-400',
  },
};

const levelOf = (log) => LEVELS[log.level] || LEVELS.info;

/**
 * The services the filter row offers, named exactly as they are written into the
 * action — a made-up display name ("auth-api") would not match what the row
 * beneath it says, and the row is the thing an operator greps for.
 */
const SERVICES = ['auth', 'admin', 'device', 'staff', 'safezone', 'upload'];

/** The window the stream is read through. `minutes: null` is the whole history. */
const RANGES = [
  { value: '15m', label: 'Last 15 minutes', minutes: 15 },
  { value: '1h', label: 'Last hour', minutes: 60 },
  { value: '24h', label: 'Last 24 hours', minutes: 60 * 24 },
  { value: '7d', label: 'Last 7 days', minutes: 60 * 24 * 7 },
  { value: '30d', label: 'Last 30 days', minutes: 60 * 24 * 30 },
  { value: 'all', label: 'All time', minutes: null },
];

// A day, not the fifteen minutes the reference design opens on: a console that
// greets a quiet platform with an empty table reads as broken rather than calm.
const DEFAULT_RANGE = '24h';

/** Words that look wrong sentence-cased. */
const ACRONYMS = { mfa: 'MFA', ip: 'IP', sms: 'SMS', api: 'API' };

/**
 * `admin.user_password_reset` → "User password reset".
 *
 * The service is already its own column, so the message only carries the event.
 */
const describe = (action) => {
  const dot = String(action || '').indexOf('.');
  const event = dot > 0 ? action.slice(dot + 1) : String(action || 'unknown');
  const words = event.split('_').map((word) => ACRONYMS[word] || word);
  const [first, ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
};

/**
 * The mono line under the message: what the entry was about, and whatever the
 * writer thought worth recording with it.
 *
 * Nested values are dropped rather than stringified — a JSON blob unrolled into
 * a table cell is noise, and the detail panel this screen does not have is what
 * would show it properly.
 */
const detailOf = (log) => {
  const bits = [];
  if (log.entity) bits.push(`${log.entity}${log.entityId ? ` #${log.entityId.slice(0, 8)}` : ''}`);

  Object.entries(log.metadata || {}).forEach(([key, value]) => {
    if (value === null || value === undefined || value === '') return;
    if (Array.isArray(value)) {
      if (value.length) bits.push(`${key}=${value.slice(0, 3).join('|')}${value.length > 3 ? '…' : ''}`);
      return;
    }
    if (typeof value === 'object') return;
    bits.push(`${key}=${value}`);
  });

  return bits.join(' · ');
};

/** Date and time to the millisecond — the precision you correlate two logs by. */
const stampOf = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { day: '—', time: '' };
  return {
    day: date.toLocaleDateString(),
    time: `${date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
      + `.${String(date.getMilliseconds()).padStart(3, '0')}`,
  };
};

const actorOf = (log) => (log.user ? `${log.user.name} · ${log.user.email}` : 'System');

export default function AdminSystemLogs() {
  const [logs, setLogs] = useState([]);
  const [count, setCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');

  /**
   * Level, service and range come out of the URL when there is one.
   *
   * The Overview's severity tiles link straight into this screen — "3 critical"
   * has to open the three, not the unfiltered stream with the operator left to
   * reproduce the filter by hand. They are written back as they change, so the
   * screen an operator is looking at is always the screen its address describes.
   */
  const [params, setParams] = useSearchParams();
  const [level, setLevel] = useState(() => (LEVELS[params.get('level')] ? params.get('level') : ''));
  const [service, setService] = useState(() => (SERVICES.includes(params.get('service')) ? params.get('service') : ''));
  const [range, setRange] = useState(() => (
    RANGES.some((r) => r.value === params.get('range')) ? params.get('range') : DEFAULT_RANGE
  ));
  const [live, setLive] = useState(false);

  useEffect(() => {
    const next = {};
    if (level) next.level = level;
    if (service) next.service = service;
    if (range !== DEFAULT_RANGE) next.range = range;
    setParams(next, { replace: true });
  }, [level, service, range, setParams]);

  // The newest entry of the previous poll, so a tail can mark what arrived since.
  const newestRef = useRef(null);
  const [fresh, setFresh] = useState(() => new Set());

  const filtered = !!(appliedSearch || level || service) || range !== DEFAULT_RANGE;

  /**
   * The current filters as query parameters.
   *
   * `from` is computed at call time rather than held in state: a fifteen-minute
   * window that was pinned when the select changed would stop being the last
   * fifteen minutes about a second later, and a tail would then poll a window
   * sliding away from the present.
   */
  const query = useCallback((extra = {}) => {
    const window = RANGES.find((r) => r.value === range);
    return {
      q: appliedSearch || undefined,
      level: level || undefined,
      service: service || undefined,
      from: window?.minutes ? new Date(Date.now() - window.minutes * 60000).toISOString() : undefined,
      limit: PAGE_SIZE,
      offset,
      ...extra,
    };
  }, [appliedSearch, level, service, range, offset]);

  const load = useCallback((options = {}) => {
    const { quiet = false } = options;
    if (!quiet) setLoading(true);

    return adminApi.getAuditLogs(query())
      .then((r) => {
        const rows = r.data.rows;

        // Everything above the entry that used to be newest arrived since the
        // last poll. A previous top row that is no longer on the page means too
        // much has changed to highlight anything honestly, so nothing is.
        const previous = newestRef.current;
        newestRef.current = rows[0]?.id ?? null;
        if (quiet && previous) {
          const seen = rows.findIndex((row) => row.id === previous);
          setFresh(new Set(seen > 0 ? rows.slice(0, seen).map((row) => row.id) : []));
        }

        setLogs(rows);
        setCount(r.data.count);
        setError('');
      })
      .catch((e) => setError(errorMessage(e, 'Failed to load the system logs')))
      .finally(() => { if (!quiet) setLoading(false); });
  }, [query]);

  useEffect(() => { load(); }, [load]);

  // Typing is not a query. Everything else applies as soon as it is chosen.
  useEffect(() => {
    const id = setTimeout(() => {
      setAppliedSearch((current) => (current === search.trim() ? current : search.trim()));
      setOffset((current) => (current === 0 ? current : 0));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search]);

  /**
   * The tail. Paused while the tab is hidden — a console left open on a second
   * monitor overnight would otherwise ask for the same page twelve times a
   * minute until someone came back to it.
   */
  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(() => { if (!document.hidden) load({ quiet: true }); }, TAIL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [live, load]);

  // A highlight that never fades turns the whole page yellow after a minute.
  useEffect(() => {
    if (fresh.size === 0) return undefined;
    const id = setTimeout(() => setFresh(new Set()), 4000);
    return () => clearTimeout(id);
  }, [fresh]);

  const narrow = (apply) => {
    setOffset(0);
    setFresh(new Set());
    apply();
  };

  // Live means the top of the stream. Page two of a tail is a contradiction, so
  // paging turns it off rather than quietly showing something that is not live.
  const goToOffset = (next) => {
    if (next !== 0) setLive(false);
    setFresh(new Set());
    setOffset(next);
  };

  const startTail = (on) => {
    setLive(on);
    if (on) {
      newestRef.current = logs[0]?.id ?? null;
      setOffset(0);
    }
  };

  const clearFilters = () => narrow(() => {
    setSearch('');
    setAppliedSearch('');
    setLevel('');
    setService('');
    setRange(DEFAULT_RANGE);
  });

  /**
   * The filtered stream as a spreadsheet — an incident write-up needs the rows,
   * not a screenshot of them. It refetches rather than exporting the fifty on
   * screen, because an "export" that means "export this page" is a trap.
   */
  const exportCsv = async () => {
    setExporting(true);
    try {
      const { data } = await adminApi.getAuditLogs(query({ limit: 200, offset: 0 }));
      const header = ['Timestamp', 'Level', 'Service', 'Action', 'Message', 'Detail', 'Actor', 'Email', 'Source', 'User agent'];
      const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
      const csv = [
        header.map(cell).join(','),
        ...data.rows.map((log) => [
          new Date(log.createdAt).toISOString(),
          (LEVELS[log.level] || LEVELS.info).label,
          log.service || '',
          log.action,
          describe(log.action),
          detailOf(log),
          log.user?.name || 'System',
          log.user?.email || '',
          log.ipAddress || '',
          log.userAgent || '',
        ].map(cell).join(',')),
      ].join('\n');

      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `parentix-system-logs-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);

      if (data.count > data.rows.length) {
        setError(`Exported the most recent ${data.rows.length} of ${data.count} entries. Narrow the filters for the rest.`);
      }
    } catch (e) {
      setError(errorMessage(e, 'Failed to export the log stream'));
    } finally {
      setExporting(false);
    }
  };

  /**
   * When, how bad, from where, what — the order a log line is read in. The card
   * shape below `lg` ignores it: `DataTable` lifts the `primary` column to the
   * top of the card and labels the rest, so the message leads on a phone.
   */
  const columns = [
    {
      key: 'timestamp',
      header: 'Timestamp',
      cell: (log) => {
        const stamp = stampOf(log.createdAt);
        return (
          <span className="block whitespace-nowrap font-mono text-[11px] leading-tight tabular-nums text-gray-500">
            <span className="block">{stamp.day}</span>
            <span className="block text-gray-400">{stamp.time}</span>
          </span>
        );
      },
    },
    {
      key: 'level',
      header: 'Level',
      cell: (log) => {
        const tone = levelOf(log);
        return (
          <span className={`badge justify-center w-[4.5rem] uppercase tracking-wide text-[10px] font-bold ${tone.badge}`}>
            {tone.label}
          </span>
        );
      },
    },
    {
      key: 'service',
      header: 'Service',
      cell: (log) => (
        // The service is also the filter — the column an operator reads to decide
        // "only this one" is the sensible place to say it.
        <button
          type="button"
          onClick={() => narrow(() => setService((current) => (current === log.service ? '' : log.service)))}
          aria-label={`Show only ${log.service}`}
          // A full target on a phone card, and back to the height of a table
          // line on a desktop, where it sits among four other single-line cells.
          className="font-mono text-xs text-primary-700 hover:text-primary-800 hover:underline
                     inline-flex items-center min-h-[44px] lg:min-h-0 lg:py-2 lg:-my-2
                     rounded max-w-[8rem] truncate text-left"
        >
          {log.service}
        </button>
      ),
    },
    {
      key: 'message',
      header: 'Message',
      primary: true,
      cell: (log) => {
        const tone = levelOf(log);
        const detail = detailOf(log);
        return (
          // Explicit caps, not just `truncate`: an auto-laid-out table takes its
          // width from its content, so one long metadata line would widen this
          // column and push the source address into a scroller nobody sees.
          <span className="block min-w-0 lg:max-w-[20rem] xl:max-w-[26rem] 2xl:max-w-[34rem]">
            <span className={`block text-sm font-medium truncate ${tone.message}`}>
              {describe(log.action)}
              <span className="font-normal text-gray-400"> — {actorOf(log)}</span>
            </span>
            {detail && (
              <span className={`block font-mono text-[11px] truncate mt-0.5 ${tone.detail}`}>{detail}</span>
            )}
          </span>
        );
      },
    },
    {
      key: 'source',
      header: 'IP / source',
      align: 'right',
      cell: (log) => (
        <span
          className="block font-mono text-[11px] text-gray-400 truncate lg:max-w-[8rem] ml-auto"
          title={log.userAgent || undefined}
        >
          {/* No address means the entry was not written for a client request. */}
          {log.ipAddress || 'internal'}
        </span>
      ),
    },
  ];

  const labelClass = 'block text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400 mb-1.5';
  const controlClass = 'input min-h-[42px] py-2 sm:text-sm';

  return (
    <div className="space-y-4 sm:space-y-5">
      {/* What the screen is for, and the two things it can do about it. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-gray-500 max-w-xl">
          Real-time and historical event tracking. Every authentication, staff action, device
          enrolment and configuration change the platform has recorded, newest first.
        </p>
        <div className="flex items-center gap-2">
          <Toggle
            layout="inline"
            checked={live}
            onChange={startTail}
            label="Live tail"
            size="sm"
          />
          <button type="button" onClick={exportCsv} disabled={exporting || loading} className="btn-primary btn-sm">
            <Icon name="download" size={15} />
            {exporting ? 'Exporting…' : 'Export CSV'}
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

      {/* ── The filters ────────────────────────────────────────────────────── */}
      <div className="card p-4 sm:p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 sm:gap-4">
          <div>
            <label htmlFor="log-search" className={labelClass}>Search logs</label>
            <div className="relative">
              <Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                id="log-search"
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Action, entity, address or the staff member behind it…"
                className={`${controlClass} pl-9`}
              />
            </div>
          </div>

          <div>
            <label htmlFor="log-level" className={labelClass}>Event level</label>
            <select
              id="log-level"
              value={level}
              onChange={(e) => narrow(() => setLevel(e.target.value))}
              className={controlClass}
            >
              <option value="">All levels</option>
              {Object.entries(LEVELS).map(([value, { label }]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="log-range" className={labelClass}>Time range</label>
            <select
              id="log-range"
              value={range}
              onChange={(e) => narrow(() => setRange(e.target.value))}
              className={controlClass}
            >
              {RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-gray-100">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400 mr-1">
            Services
          </span>
          {[{ value: '', label: 'All services' }, ...SERVICES.map((s) => ({ value: s, label: s }))].map((option) => (
            <button
              key={option.value || 'all'}
              type="button"
              onClick={() => narrow(() => setService(option.value))}
              aria-pressed={service === option.value}
              // Compact on a desktop, where seven of these share a row; a full
              // 44px target on a phone, where one of them is a thumb.
              className={`chip min-h-[44px] sm:min-h-[32px] px-3 py-1 text-xs ${option.value ? 'font-mono' : 'font-semibold'} ${
                service === option.value ? 'chip-active' : ''
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <DataTable
        title="Event stream"
        dense
        toolbar={(
          <div className="flex items-center gap-3 text-xs text-gray-400">
            {live && (
              <span className="inline-flex items-center gap-1.5 font-medium text-success">
                <span className="relative flex w-2 h-2">
                  <span className="absolute inline-flex w-full h-full rounded-full bg-success opacity-60 animate-ping" />
                  <span className="relative inline-flex w-2 h-2 rounded-full bg-success" />
                </span>
                Tailing
              </span>
            )}
            <span className="tabular-nums">{count.toLocaleString()} recorded</span>
            {filtered && (
              <button type="button" onClick={clearFilters} className="btn-secondary btn-sm">
                <Icon name="close" size={14} />
                Clear filters
              </button>
            )}
          </div>
        )}
        columns={columns}
        rows={logs}
        rowKey={(log) => log.id}
        rowClass={(log) => [
          levelOf(log).row,
          // Arrived while you were watching.
          fresh.has(log.id) ? 'animate-fade-in ring-1 ring-inset ring-primary-200' : '',
        ].filter(Boolean).join(' ')}
        loading={loading}
        loadingLabel="Loading the log stream…"
        empty={(
          <EmptyState
            icon="file"
            title={filtered ? 'No events match' : 'No events recorded'}
            description={filtered
              ? 'Nothing in this window matches those filters — widen the time range or clear them.'
              : 'Authentications, staff actions and device changes are recorded here as they happen.'}
          />
        )}
        pagination={{ offset, limit: PAGE_SIZE, count, onChange: goToOffset, disabled: loading, label: 'events' }}
      />
    </div>
  );
}
