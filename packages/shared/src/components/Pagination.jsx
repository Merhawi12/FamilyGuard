/**
 * Offset pagination for the admin tables.
 *
 * The API returns `{ rows, count }`, so the caller owns `offset` and passes the
 * total back in. Rendering nothing when everything already fits keeps short
 * lists uncluttered.
 */
export default function Pagination({ offset, limit, count, onChange, label = 'rows', disabled = false }) {
  const total = Number(count) || 0;
  if (total <= limit) return null;

  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + limit, total);

  const go = (next) => onChange(Math.max(0, Math.min(next, (pages - 1) * limit)));

  const button = 'px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 '
    + 'hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-transparent transition';

  return (
    <div className="flex items-center justify-between gap-3 flex-wrap pt-4 mt-2 border-t border-gray-100">
      <p className="text-xs text-gray-500">
        Showing <span className="font-medium text-gray-700">{first}–{last}</span> of{' '}
        <span className="font-medium text-gray-700">{total}</span> {label}
      </p>

      <div className="flex items-center gap-2">
        <button type="button" className={button} onClick={() => go(0)} disabled={disabled || page === 1}>
          « First
        </button>
        <button type="button" className={button} onClick={() => go(offset - limit)} disabled={disabled || page === 1}>
          ‹ Previous
        </button>
        <span className="text-xs text-gray-500 px-1">Page {page} of {pages}</span>
        <button type="button" className={button} onClick={() => go(offset + limit)} disabled={disabled || page === pages}>
          Next ›
        </button>
        <button type="button" className={button} onClick={() => go((pages - 1) * limit)} disabled={disabled || page === pages}>
          Last »
        </button>
      </div>
    </div>
  );
}
