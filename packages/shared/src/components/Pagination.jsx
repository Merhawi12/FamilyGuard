import Icon from './Icon.jsx';

/**
 * Offset pagination.
 *
 * The API returns `{ rows, count }`, so the caller owns `offset` and passes the
 * total back in. Rendering nothing when everything already fits keeps short
 * lists uncluttered.
 *
 * Numbered pages, because "page 7 of 124" tells you where you are but not how to
 * get to page 9 without pressing Next twice. At most five numbers are drawn, with
 * an ellipsis standing in for each gap, so the row is the same width whether the
 * table has three pages or three hundred.
 *
 * Those numbers do not fit across a phone: seven controls and a range summary is
 * about 420px of content. Below `sm` this is Previous / position / Next — the
 * numbers are a convenience, and a row that overflows the screen is not one.
 */

/**
 * The pages worth offering: the first, the last, and the ones either side of
 * where you are. `page: null` is a gap rather than a destination.
 */
const pageWindow = (page, pages) => {
  if (pages <= 5) {
    return Array.from({ length: pages }, (_, i) => ({ key: i + 1, page: i + 1 }));
  }

  const first = Math.max(2, Math.min(page - 1, pages - 3));
  const last = Math.min(pages - 1, Math.max(page + 1, 4));

  const entries = [{ key: 1, page: 1 }];
  if (first > 2) entries.push({ key: 'gap-before', page: null });
  for (let p = first; p <= last; p += 1) entries.push({ key: p, page: p });
  if (last < pages - 1) entries.push({ key: 'gap-after', page: null });
  entries.push({ key: pages, page: pages });

  return entries;
};

export default function Pagination({ offset, limit, count, onChange, label = 'rows', disabled = false }) {
  const total = Number(count) || 0;
  if (total <= limit) return null;

  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + limit, total);

  const go = (next) => onChange(Math.max(0, Math.min(next, (pages - 1) * limit)));

  const button = 'inline-flex items-center justify-center gap-1 min-h-[36px] px-3 rounded-lg text-xs '
    + 'font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 '
    + 'disabled:opacity-40 disabled:hover:bg-transparent transition';

  return (
    <div className="flex items-center justify-between gap-3 flex-wrap pt-4 mt-3 border-t border-gray-100">
      <p className="text-xs text-gray-500 order-2 sm:order-1 w-full sm:w-auto text-center sm:text-left">
        Showing <span className="font-medium text-gray-700">{first}–{last}</span> of{' '}
        <span className="font-medium text-gray-700">{total}</span> {label}
      </p>

      <div className="flex items-center gap-1.5 order-1 sm:order-2 w-full sm:w-auto justify-between sm:justify-end">
        <button type="button" className={button} onClick={() => go(offset - limit)} disabled={disabled || page === 1}>
          <Icon name="chevronLeft" size={14} strokeWidth={2.2} />
          <span className="sm:hidden md:inline">Previous</span>
        </button>

        {/* Where you are, for the phone that has no room for the numbers. */}
        <span className="text-xs text-gray-500 px-1 whitespace-nowrap sm:hidden">{page} / {pages}</span>

        <span className="hidden sm:flex items-center gap-1">
          {pageWindow(page, pages).map(({ key, page: target }) => (target === null ? (
            <span key={key} className="px-1 text-xs text-gray-400 select-none" aria-hidden="true">…</span>
          ) : (
            <button
              key={key}
              type="button"
              onClick={() => go((target - 1) * limit)}
              disabled={disabled}
              aria-current={target === page ? 'page' : undefined}
              aria-label={`Page ${target}`}
              className={`inline-flex items-center justify-center min-w-[36px] min-h-[36px] px-2 rounded-lg
                          text-xs font-semibold transition disabled:opacity-40 ${
                target === page
                  ? 'bg-primary-600 text-white'
                  : 'border border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {target}
            </button>
          )))}
        </span>

        <button
          type="button" className={button}
          onClick={() => go(offset + limit)} disabled={disabled || page === pages}
        >
          <span className="sm:hidden md:inline">Next</span>
          <Icon name="chevronRight" size={14} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  );
}
