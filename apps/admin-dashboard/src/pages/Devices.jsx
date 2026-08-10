import { useCallback, useEffect, useRef, useState } from 'react';
import { admin as adminApi, errorMessage, EmptyState, Icon } from '@parentix/shared';
import DataTable from '../components/DataTable';
import StatTile from '../components/StatTile';

/**
 * Device Control — the whole fleet on one screen.
 *
 * Three things at three levels of zoom: the tiles say whether the platform is
 * healthy, the table says which device is not, and the panel beside it says
 * everything known about the one you picked. The topology card is the same page
 * of the table seen at a glance — one dot per device, clickable into the panel.
 *
 * What the screen deliberately does not have is remote control. A device is
 * enrolled by its own linking code and removed by the parent who owns it; there
 * is no channel from the console to a child's phone, so there is no "lock" or
 * "ping" button here pretending otherwise. Every number and field below comes
 * from `GET /admin/devices`.
 */

const PAGE_SIZE = 25;

const STATUS = {
  online: { label: 'Active', badge: 'badge-green', dot: 'bg-success' },
  offline: { label: 'Offline', badge: 'badge-red', dot: 'bg-danger' },
  pending: { label: 'Awaiting link', badge: 'badge-amber', dot: 'bg-warning' },
};

const PLATFORMS = [
  { value: 'android', label: 'Android', icon: 'phone' },
  { value: 'ios', label: 'iOS', icon: 'phone' },
  { value: 'windows', label: 'Windows', icon: 'desktop' },
  { value: 'mac', label: 'macOS', icon: 'laptop' },
];

// A type the apps do not offer still has to render as something: the API reports
// anything else as "other", and a device row can predate a renamed type.
const platformOf = (type) => PLATFORMS.find((p) => p.value === type) || {
  value: type,
  label: type ? type[0].toUpperCase() + type.slice(1) : 'Unknown',
  icon: 'devices',
};

/** How the reporting bar is split, in the order the segments are drawn. */
const REPORTING = [
  { key: 'live', label: 'Reporting now', bar: 'bg-success', dot: 'bg-success' },
  { key: 'today', label: 'Seen today', bar: 'bg-primary-500', dot: 'bg-primary-500' },
  { key: 'stale', label: 'Silent over a day', bar: 'bg-warning', dot: 'bg-warning' },
  { key: 'pending', label: 'Never connected', bar: 'bg-gray-300', dot: 'bg-gray-300' },
];

const timeAgo = (value) => {
  if (!value) return 'never';
  const minutes = Math.round((Date.now() - new Date(value)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

/**
 * Date and time to the minute.
 *
 * `toLocaleString()` spells out the seconds, and a 320px panel column wraps that
 * onto a second line for a precision nobody reads off a fleet screen.
 */
const compactDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

/** A device id is a UUID; support quotes the front of it, not all 36 characters. */
const shortId = (id) => `PTX-${String(id).slice(0, 8).toUpperCase()}`;

// ── Pieces of the screen ─────────────────────────────────────────────────────

/**
 * The fleet by platform, on the navy surface the rail uses.
 *
 * This is the slot the reference design gives to platform-wide overrides —
 * "pause all traffic", "push policy to every device". Neither exists: policy
 * reaches a device when it next asks for its rules, and nothing in the platform
 * can stop a phone's traffic from here. So the weight of that card goes to the
 * one platform-wide fact the console does hold.
 */
function CompositionCard({ summary }) {
  const total = summary.byPlatform.reduce((sum, p) => sum + p.count, 0);

  return (
    <div className="rounded-2xl bg-navy-900 text-white p-4 sm:p-5 shadow-card">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-white/10 shrink-0">
          <Icon name="devices" size={17} />
        </span>
        <h2 className="text-sm font-semibold">Fleet by platform</h2>
      </div>

      {total === 0 ? (
        <p className="mt-4 text-xs text-navy-300">No devices enrolled yet.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {summary.byPlatform.filter((p) => p.count > 0).map((p) => (
            <li key={p.platform}>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="font-medium text-navy-200 truncate">{platformOf(p.platform).label}</span>
                <span className="text-navy-300 shrink-0 tabular-nums">
                  {p.count} · {Math.round((p.count / total) * 100)}%
                </span>
              </div>
              <div className="mt-1.5 h-1.5 rounded-full bg-white/10 overflow-hidden">
                <div className="h-full rounded-full bg-primary-500" style={{ width: `${(p.count / total) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 pt-3 border-t border-white/10 text-[11px] leading-relaxed text-navy-300">
        Rules reach a device when it next checks in — about every five minutes while it is awake.
      </p>
    </div>
  );
}

/** When the fleet last reported, as one bar and its legend. */
function ReportingCard({ summary }) {
  const { reporting } = summary;
  const total = REPORTING.reduce((sum, seg) => sum + (reporting[seg.key] || 0), 0);

  return (
    <div className="card p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="section-title">Reporting activity</h2>
        <Icon name="activity" size={17} className="text-gray-400" />
      </div>

      <div className="mt-4 flex h-2.5 rounded-full bg-gray-100 overflow-hidden" aria-hidden="true">
        {total > 0 && REPORTING.map((seg) => (reporting[seg.key] ? (
          <div key={seg.key} className={seg.bar} style={{ width: `${(reporting[seg.key] / total) * 100}%` }} />
        ) : null))}
      </div>

      <dl className="mt-4 space-y-2">
        {REPORTING.map((seg) => (
          <div key={seg.key} className="flex items-center justify-between gap-3 text-xs">
            <dt className="flex items-center gap-2 min-w-0 text-gray-600">
              <span className={`w-2 h-2 rounded-full shrink-0 ${seg.dot}`} />
              <span className="truncate">{seg.label}</span>
            </dt>
            <dd className="font-semibold text-gray-900 tabular-nums shrink-0">{reporting[seg.key]}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-4 pt-3 border-t border-gray-100 text-[11px] leading-relaxed text-gray-400">
        A device counts as active while its last heartbeat is under {summary.onlineWindowMinutes} minutes old.
      </p>
    </div>
  );
}

/**
 * The fleet drawn as the shape it actually has.
 *
 * A star, not a mesh: every device holds its own link to Parentix and none of
 * them talk to each other, so the hub is the service and each spoke is one
 * device's connection to it. A device that has gone quiet keeps its node and
 * loses its line — which is the whole point of drawing this rather than reading
 * the same three numbers off the tiles a second time.
 *
 * It draws the devices on the current page, because those are the devices the
 * console has in hand; the fleet-wide count is stated under it so a page of 25
 * out of 142 never reads as the whole platform.
 */

/**
 * Where the nodes sit. Ellipses, not circles — the card is wider than it is
 * tall. The box is taller than the rings need: the bottom band is empty on
 * purpose, so the legend has somewhere to sit that no spoke runs through.
 */
const PLOT = { w: 320, h: 244, cx: 160, cy: 100 };
const RINGS = { outer: { rx: 128, ry: 76 }, inner: { rx: 74, ry: 44 } };

// `dot` repeats `fill` as a background because Tailwind scans source text: a
// class assembled at runtime from the other one is never generated.
const NODE = {
  online: { fill: 'fill-navy-700', dot: 'bg-navy-700', link: 'stroke-gray-300', dash: null },
  offline: { fill: 'fill-danger', dot: 'bg-danger', link: 'stroke-gray-200', dash: '3 3' },
  pending: { fill: 'fill-gray-300', dot: 'bg-gray-300', link: 'stroke-gray-200', dash: '3 3' },
};

/**
 * Lay the devices out around the hub.
 *
 * One ring reads as a star up to about nine devices; past that the nodes crowd
 * together, so the tail of the list moves to an inner ring, offset by half a
 * step so its spokes fall between the outer ones instead of behind them.
 */
const topologyNodes = (devices) => {
  const inner = devices.length <= 9 ? 0 : Math.floor(devices.length * 0.38);
  const outer = devices.length - inner;

  const place = (index, total, ring, offset) => {
    const angle = (index / total) * 2 * Math.PI - Math.PI / 2 + offset;
    return { x: PLOT.cx + ring.rx * Math.cos(angle), y: PLOT.cy + ring.ry * Math.sin(angle) };
  };

  return devices.map((device, i) => ({
    device,
    ...(i < outer
      ? place(i, outer, RINGS.outer, 0)
      : place(i - outer, inner, RINGS.inner, Math.PI / inner)),
  }));
};

function TopologyCard({ devices, summary, selectedId, onSelect }) {
  const nodes = topologyNodes(devices);
  // Node radius shrinks as the page fills up, so 25 devices stay separate dots
  // rather than one ring of overlapping circles.
  const r = devices.length <= 8 ? 7 : devices.length <= 16 ? 6 : 5;

  const counts = devices.reduce((acc, d) => {
    const key = STATUS[d.status] ? d.status : 'pending';
    acc[key] += 1;
    return acc;
  }, { online: 0, offline: 0, pending: 0 });

  const legend = Object.keys(NODE).filter((key) => counts[key] > 0);

  return (
    <div className="card p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="section-title">Network topology</h2>
        <Icon name="network" size={17} className="text-gray-400" />
      </div>

      {devices.length === 0 ? (
        <p className="mt-4 text-xs text-gray-500">Nothing to draw — no devices on this page of the fleet.</p>
      ) : (
        <div className="relative mt-4 rounded-xl border border-gray-100 bg-gray-50/70 p-1">
          {/* One picture, described once: every node here is also a row in the
              table beside it, and the row carries the button a keyboard uses. */}
          <svg
            viewBox={`0 0 ${PLOT.w} ${PLOT.h}`}
            className="w-full h-auto"
            role="img"
            aria-label={`${devices.length} devices around the Parentix service: ${counts.online} active, ${counts.offline} offline, ${counts.pending} awaiting a link.`}
          >
            {nodes.map(({ device, x, y }) => {
              const node = NODE[device.status] || NODE.pending;
              const selected = device.id === selectedId;
              return (
                <line
                  key={`link-${device.id}`}
                  x1={PLOT.cx}
                  y1={PLOT.cy}
                  x2={x}
                  y2={y}
                  strokeWidth={selected ? 2 : 1}
                  strokeDasharray={node.dash || undefined}
                  className={selected ? 'stroke-primary-500' : node.link}
                />
              );
            })}

            {/* The service every one of those lines ends at. */}
            <circle cx={PLOT.cx} cy={PLOT.cy} r="19" className="fill-navy-200/50" />
            <circle cx={PLOT.cx} cy={PLOT.cy} r="11" className="fill-navy-900">
              <title>Parentix — every device checks in here</title>
            </circle>

            {nodes.map(({ device, x, y }) => {
              const node = NODE[device.status] || NODE.pending;
              const status = STATUS[device.status] || STATUS.pending;
              const selected = device.id === selectedId;
              return (
                <g
                  key={device.id}
                  onClick={() => onSelect(device)}
                  className="cursor-pointer"
                  data-device={device.id}
                >
                  {selected && (
                    <circle cx={x} cy={y} r={r + 4} className="fill-none stroke-primary-500" strokeWidth="2" />
                  )}
                  {/* A dot small enough to read as a node is smaller than a
                      pointer target, so the hit area is its own circle. */}
                  <circle cx={x} cy={y} r={Math.max(r + 6, 11)} fill="transparent" />
                  <circle cx={x} cy={y} r={r} className={node.fill} />
                  <title>{`${device.name} — ${status.label}, last sync ${timeAgo(device.lastSeen)}`}</title>
                </g>
              );
            })}
          </svg>

          <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-x-3 gap-y-1
                          rounded-lg border border-gray-100 bg-white/90 px-2.5 py-1.5 shadow-sm">
            {legend.map((key) => (
              <span key={key} className="flex items-center gap-1.5 text-[10px] text-gray-600">
                <span className={`w-2 h-2 rounded-full ${NODE[key].dot}`} />
                {STATUS[key].label}
                <span className="font-semibold tabular-nums text-gray-900">{counts[key]}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <p className="mt-4 pt-3 border-t border-gray-100 text-[11px] leading-relaxed text-gray-400">
        {devices.length < summary.total
          ? `The ${devices.length} device${devices.length === 1 ? '' : 's'} on this page, of ${summary.total} enrolled. `
          : ''}
        Each device holds its own link to Parentix — there is no device-to-device traffic to draw.
      </p>
    </div>
  );
}

/** A labelled line in the detail panel. */
function Field({ label, children }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400">{label}</dt>
      <dd className="mt-0.5 text-sm text-gray-900 break-words">{children}</dd>
    </div>
  );
}

/**
 * Everything known about one device.
 *
 * Focusable and focused on selection, because on a phone the panel is below a
 * table that can be a screen and a half long — selecting a row has to take you
 * to what you selected.
 */
function DetailPanel({ device, panelRef }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => { setCopied(false); }, [device?.id]);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(device.id);
      setCopied(true);
    } catch {
      // A denied clipboard is not an error worth a banner — the id is on screen.
      setCopied(false);
    }
  };

  if (!device) {
    return (
      <div ref={panelRef} tabIndex={-1} className="card outline-none">
        <EmptyState
          icon="devices"
          title="No device selected"
          description="Pick a device from the fleet to see its owner, its policy and when it last reported."
        />
      </div>
    );
  }

  const platform = platformOf(device.type);
  const status = STATUS[device.status] || STATUS.pending;
  const policy = device.policy;

  return (
    <div ref={panelRef} tabIndex={-1} className="card p-4 sm:p-5 outline-none">
      <div className="flex items-start gap-3">
        <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-navy-50 text-navy-700 shrink-0">
          <Icon name={platform.icon} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-gray-900 truncate">{device.name}</h2>
          <p className="text-[11px] font-mono text-gray-400 truncate">{shortId(device.id)}</p>
        </div>
        <span className={`${status.badge} shrink-0`}>{status.label}</span>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4">
        <Field label="Assigned to">
          <span className="block truncate">{device.child?.name || '—'}</span>
          {device.child?.age ? <span className="block text-xs text-gray-400">age {device.child.age}</span> : null}
        </Field>
        <Field label="Platform">
          {platform.label}
          {device.osVersion ? <span className="text-gray-400"> {device.osVersion}</span> : null}
        </Field>
        <Field label="Account">
          <span className="block truncate">{device.owner?.name || '—'}</span>
          <span className="block text-xs text-gray-500 truncate">{device.owner?.email || ''}</span>
        </Field>
        <Field label="Plan">
          <span className={device.owner?.plan === 'premium' ? 'badge-green' : 'badge-gray'}>
            {device.owner?.plan || 'unknown'}
          </span>
          {device.owner && !device.owner.isActive && <span className="badge-red ml-1">blocked</span>}
        </Field>
        <Field label="Last sync">
          <span className="block">{timeAgo(device.lastSeen)}</span>
          <span className="block text-xs text-gray-400">{compactDate(device.lastSeen)}</span>
        </Field>
        <Field label="Enrolled">
          {device.isLinked
            ? <span className="block text-sm">{compactDate(device.createdAt)}</span>
            : <span className="block text-sm text-gray-500">Awaiting the linking code</span>}
        </Field>
      </dl>

      <div className="mt-5 pt-4 border-t border-gray-100">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400">Policy in force</p>
        {policy ? (
          <ul className="mt-2 space-y-1.5 text-sm text-gray-700">
            <li className="flex items-center justify-between gap-3">
              <span>Daily screen-time limit</span>
              <span className="font-semibold tabular-nums">
                {policy.dailyLimitMinutes == null ? 'none set' : `${policy.dailyLimitMinutes} min`}
              </span>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span>Blocked apps</span>
              <span className="font-semibold tabular-nums">{policy.appRules}</span>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span>Website rules</span>
              <span className="font-semibold tabular-nums">{policy.websiteRules}</span>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span>Bedtime</span>
              <span className="font-semibold">{policy.bedtimeEnabled ? 'on' : 'off'}</span>
            </li>
          </ul>
        ) : (
          <p className="mt-2 text-sm text-gray-500">No rules recorded for this child.</p>
        )}
      </div>

      <div className="mt-5 pt-4 border-t border-gray-100 space-y-3">
        <p className="text-xs text-gray-500">
          Push notifications: {device.pushRegistered ? 'registered' : 'not registered'}
        </p>
        <button type="button" onClick={copyId} className="btn-secondary btn-sm btn-block">
          <Icon name={copied ? 'check' : 'copy'} size={15} />
          {copied ? 'Device ID copied' : 'Copy full device ID'}
        </button>
        <p className="text-[11px] leading-relaxed text-gray-400">
          The console reads the fleet. Enrolling or removing a device stays with the parent who owns it.
        </p>
      </div>
    </div>
  );
}

// ── The screen ───────────────────────────────────────────────────────────────

export default function AdminDevices() {
  const [rows, setRows] = useState([]);
  const [count, setCount] = useState(0);
  const [summary, setSummary] = useState(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [selectedId, setSelectedId] = useState(null);

  // As with the user directory: `search` is what is typed, `appliedSearch` is
  // what the last submit asked for, so a keystroke never fires a request.
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [filters, setFilters] = useState({ status: '', platform: '' });

  const panelRef = useRef(null);

  const query = useCallback((extra = {}) => ({
    search: appliedSearch || undefined,
    status: filters.status || undefined,
    platform: filters.platform || undefined,
    ...extra,
  }), [appliedSearch, filters]);

  const load = useCallback(() => {
    setLoading(true);
    return adminApi.listDevices(query({ limit: PAGE_SIZE, offset }))
      .then((r) => {
        setRows(r.data.rows);
        setCount(r.data.count);
        setSummary(r.data.summary);
      })
      .catch((e) => setError(errorMessage(e, 'Failed to load the device fleet')))
      .finally(() => setLoading(false));
  }, [offset, query]);

  useEffect(() => { load(); }, [load]);

  const submitSearch = (event) => {
    event.preventDefault();
    setOffset(0);
    setAppliedSearch(search.trim());
  };

  const setFilter = (key, value) => {
    setOffset(0);
    setFilters((f) => ({ ...f, [key]: value }));
  };

  const select = (device) => {
    setSelectedId(device.id);
    panelRef.current?.focus();
  };

  /**
   * The filtered fleet as a spreadsheet — the one thing an operator asks for that
   * a screen cannot give them. It re-fetches rather than exporting the 25 rows on
   * screen, because "export" that means "export this page" is a trap.
   */
  const exportCsv = async () => {
    setExporting(true);
    try {
      const { data } = await adminApi.listDevices(query({ limit: 200, offset: 0 }));
      const header = ['Device', 'ID', 'Platform', 'OS version', 'Status', 'Last sync', 'Child', 'Account', 'Email', 'Plan'];
      const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
      const csv = [
        header.map(cell).join(','),
        ...data.rows.map((d) => [
          d.name, d.id, platformOf(d.type).label, d.osVersion || '',
          STATUS[d.status]?.label || d.status,
          d.lastSeen ? new Date(d.lastSeen).toISOString() : '',
          d.child?.name || '', d.owner?.name || '', d.owner?.email || '', d.owner?.plan || '',
        ].map(cell).join(',')),
      ].join('\n');

      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `parentix-devices-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);

      if (data.count > data.rows.length) {
        setError(`Exported the first ${data.rows.length} of ${data.count} devices. Narrow the filters for the rest.`);
      }
    } catch (e) {
      setError(errorMessage(e, 'Failed to export the fleet'));
    } finally {
      setExporting(false);
    }
  };

  // The panel follows the table, so a device that a filter or a page change has
  // taken off screen shows nothing rather than stale detail.
  const selected = rows.find((d) => d.id === selectedId) || null;

  const columns = [
    {
      key: 'device',
      header: 'Device & user',
      primary: true,
      cell: (d) => (
        <div className="flex items-start gap-3 min-w-0">
          <span className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-gray-100 text-gray-500 shrink-0">
            <Icon name={platformOf(d.type).icon} size={17} />
          </span>
          {/* An explicit width, not just `truncate`: a table laid out
              automatically takes its width from its content, so a long account
              email would widen the column and push the actions into a scroller
              instead of shortening itself. Tightest between 1280 and 1536, where
              the detail panel sits beside a table that is only two thirds wide. */}
          <span className="min-w-0 lg:max-w-[15rem] xl:max-w-[10rem] 2xl:max-w-[15rem]">
            {/* The row is clickable for a mouse; this button is how a keyboard
                reaches the same detail panel. Padded to a 36px target and pulled
                back by the same amount, so it stays tappable on a phone without
                the name floating away from the line under it. */}
            <button
              type="button"
              onClick={() => select(d)}
              className="block max-w-full truncate text-left font-semibold text-gray-900
                         hover:text-primary-700 rounded py-2 -my-2"
            >
              {d.name}
            </button>
            <span className="block text-xs text-gray-400 truncate">
              {d.child?.name || 'Unassigned'} · {d.owner?.email || 'no account'}
            </span>
          </span>
        </div>
      ),
    },
    {
      key: 'platform',
      header: 'Platform',
      cell: (d) => (
        <span className="block min-w-0 lg:max-w-[9rem] xl:max-w-[6rem] 2xl:max-w-[9rem]">
          <span className="block text-sm text-gray-700 truncate">{platformOf(d.type).label}</span>
          <span className="block text-xs text-gray-400 truncate">{d.osVersion || 'version unknown'}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (d) => {
        const status = STATUS[d.status] || STATUS.pending;
        return (
          <span className="block min-w-0">
            <span className={`${status.badge} gap-1.5`}>
              <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
              {status.label}
            </span>
            <span className="block text-xs text-gray-400 mt-1">{timeAgo(d.lastSeen)}</span>
          </span>
        );
      },
    },
  ];

  // Labelled everywhere except the 1280–1536 band, where the label is the last
  // 50px between this table and a horizontal scrollbar.
  const actions = (d) => (
    <button
      type="button"
      onClick={() => select(d)}
      aria-label={`Details for ${d.name}`}
      className={`btn-sm ${selectedId === d.id ? 'btn-primary' : 'btn-secondary'}`}
    >
      <Icon name="chevronRight" size={15} strokeWidth={2.2} />
      <span className="xl:hidden 2xl:inline">Details</span>
    </button>
  );

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
      <form onSubmit={submitSearch} className="relative flex-1 min-w-[10rem]">
        <Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Device, child or account…"
          aria-label="Search the fleet"
          className="input pl-9 sm:min-h-[38px] sm:py-1.5 sm:text-xs"
        />
      </form>

      <select
        value={filters.status}
        onChange={(e) => setFilter('status', e.target.value)}
        aria-label="Filter by status"
        className="input w-auto sm:min-h-[38px] sm:py-1.5 sm:text-xs"
      >
        <option value="">All statuses</option>
        <option value="online">Active</option>
        <option value="offline">Offline</option>
        <option value="pending">Awaiting link</option>
      </select>

      <select
        value={filters.platform}
        onChange={(e) => setFilter('platform', e.target.value)}
        aria-label="Filter by platform"
        className="input w-auto sm:min-h-[38px] sm:py-1.5 sm:text-xs"
      >
        <option value="">All platforms</option>
        {PLATFORMS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
      </select>
    </div>
  );

  return (
    <div className="space-y-4 sm:space-y-5">
      {/* What the screen is for, and the two things it can do about it. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-gray-500 max-w-xl">
          Every device enrolled across the platform — what it is, whose it is, the policy it carries
          and when it last checked in.
        </p>
        <div className="flex items-center gap-2">
          <button type="button" onClick={load} disabled={loading} className="btn-secondary btn-sm">
            <Icon name="refresh" size={15} />
            Refresh
          </button>
          <button type="button" onClick={exportCsv} disabled={exporting || loading} className="btn-primary btn-sm">
            <Icon name="file" size={15} />
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

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 sm:gap-5 items-start">
        <div className="xl:col-span-2 space-y-4 sm:space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
            <StatTile
              label="Total endpoints"
              value={summary ? summary.total : '—'}
              unit={summary ? `${summary.pending} awaiting link` : ''}
              icon="devices"
            />
            <StatTile
              label="Sync status"
              value={summary ? `${summary.syncRate}%` : '—'}
              unit="up to date"
              icon="refresh"
            />
            <StatTile
              label="Offline devices"
              value={summary ? summary.offline : '—'}
              unit={summary && summary.offline > 0 ? 'need attention' : 'all reporting'}
              icon="warning"
              alert={!!summary && summary.offline > 0}
            />
          </div>

          <DataTable
            title="Hardware fleet"
            toolbar={toolbar}
            columns={columns}
            rows={rows}
            rowKey={(d) => d.id}
            actions={actions}
            onRowClick={select}
            selectedKey={selectedId}
            loading={loading}
            loadingLabel="Loading the device fleet…"
            empty={(
              <EmptyState
                icon="devices"
                title={appliedSearch || filters.status || filters.platform ? 'No devices match' : 'No devices enrolled'}
                description={
                  appliedSearch || filters.status || filters.platform
                    ? 'Clear the filters to see the whole fleet.'
                    : 'Devices appear here once a parent links one from the family app.'
                }
              />
            )}
            pagination={{ offset, limit: PAGE_SIZE, count, onChange: setOffset, disabled: loading, label: 'devices' }}
          />
        </div>

        <div className="space-y-4 sm:space-y-5">
          {summary && <CompositionCard summary={summary} />}
          {summary && (
            <TopologyCard devices={rows} summary={summary} selectedId={selectedId} onSelect={select} />
          )}
          {summary && <ReportingCard summary={summary} />}
          <DetailPanel device={selected} panelRef={panelRef} />
        </div>
      </div>
    </div>
  );
}
