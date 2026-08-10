import { EmptyState, Pagination } from '@parentix/shared';

/**
 * The console's one table.
 *
 * Seven screens each carried their own `<table>` inside an `overflow-x-auto`,
 * which is not a responsive table — it is a desktop table you have to drag
 * sideways, with the row's actions parked off the right edge of a phone. One
 * column definition renders both shapes here: a real table from `lg` up, and a
 * stack of cards below it where each column becomes a labelled line.
 *
 * A column is `{ key, header, cell(row), align?, primary?, hideOnCard? }`:
 *   primary     rendered on its own at the top of the card, without its label —
 *               the name or title the row is identified by
 *   hideOnCard  omitted from the card; for columns only worth the space on a
 *               wide screen (a user agent string, an internal id)
 *
 * `rowClass(row)` tints a row from its own content — the severity band down the
 * System Logs table. It is applied to both shapes, so a critical entry reads the
 * same on a phone card as it does in the table.
 *
 * `onRowClick` marks the whole row as a way of selecting it — a mouse
 * convenience for a table that drives a detail panel beside it. It is not the
 * keyboard path: a row is not focusable, so a screen that uses this must also
 * put a real control in a cell (the Device Control screen makes the device name
 * a button). `selectedKey` is compared with `rowKey(row)` to mark the row that
 * the panel is currently showing.
 */
// Spelled out rather than interpolated: Tailwind scans source text, so a class
// built as `text-${align}` is never generated and the column silently loses it.
const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' };

export default function DataTable({
  columns,
  rows,
  rowKey,
  actions,
  title,
  toolbar,
  loading = false,
  loadingLabel = 'Loading…',
  empty,
  pagination,
  onRowClick,
  selectedKey,
  rowClass,
  dense = false,
}) {
  // 40px of padding per column is comfortable for four columns and ruinous for
  // seven — the directory spends it all on gaps and then wraps its row actions
  // onto a second line. `dense` buys that space back for the content.
  const cellX = dense ? 'px-3' : 'px-5';
  const primary = columns.find((c) => c.primary);
  const rest = columns.filter((c) => !c.primary && !c.hideOnCard);

  const isSelected = (row) => selectedKey !== undefined && selectedKey !== null && rowKey(row) === selectedKey;
  const selectProps = (row) => (onRowClick
    ? { onClick: () => onRowClick(row), 'aria-current': isSelected(row) || undefined }
    : {});

  const body = () => {
    if (loading && rows.length === 0) {
      return <p className="text-sm text-gray-400 text-center py-12">{loadingLabel}</p>;
    }
    if (rows.length === 0) return empty || <EmptyState icon="inbox" title="Nothing to show" />;

    return (
      <>
        {/* ── Phone: one card per row ─────────────────────────────────────── */}
        <div className="lg:hidden divide-y divide-gray-100">
          {rows.map((row) => (
            <div
              key={rowKey(row)}
              {...selectProps(row)}
              className={`p-4 transition-colors ${onRowClick ? 'cursor-pointer' : ''} ${
                isSelected(row) ? 'bg-primary-50/70' : rowClass?.(row) || ''
              }`}
            >
              {primary && <div className="mb-2">{primary.cell(row)}</div>}

              {rest.length > 0 && (
                <dl className="space-y-1.5">
                  {rest.map((col) => (
                    <div key={col.key} className="flex items-baseline justify-between gap-3">
                      <dt className="text-xs text-gray-400 shrink-0">{col.header}</dt>
                      <dd className="text-sm text-gray-700 text-right min-w-0">{col.cell(row)}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {actions && (
                <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-gray-50">{actions(row)}</div>
              )}
            </div>
          ))}
        </div>

        {/* ── Desktop: the table ──────────────────────────────────────────── */}
        <div className="hidden lg:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                {columns.map((col) => (
                  <th key={col.key} className={`${cellX} py-3 font-medium ${ALIGN[col.align] || ALIGN.left}`}>
                    {col.header}
                  </th>
                ))}
                {actions && <th className={`${cellX} py-3 font-medium text-right`}>Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  {...selectProps(row)}
                  className={`transition align-top ${onRowClick ? 'cursor-pointer' : ''} ${
                    isSelected(row) ? 'bg-primary-50/70' : `hover:bg-gray-50 ${rowClass?.(row) || ''}`
                  }`}
                >
                  {columns.map((col) => (
                    <td key={col.key} className={`${cellX} py-4 ${ALIGN[col.align] || ALIGN.left}`}>
                      {col.cell(row)}
                    </td>
                  ))}
                  {actions && (
                    <td className={`${cellX} py-4`}>
                      <div className={`flex items-center justify-end flex-wrap ${dense ? 'gap-1.5' : 'gap-2'}`}>
                        {actions(row)}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  };

  return (
    <div className="card-flush">
      {(title || toolbar) && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-5 py-4 border-b border-gray-100">
          {title && <h2 className="section-title">{title}</h2>}
          {toolbar}
        </div>
      )}

      {body()}

      {pagination && <div className="px-4 sm:px-5 pb-4">{<Pagination {...pagination} />}</div>}
    </div>
  );
}
