import { useCallback, useEffect, useState } from 'react';
import {
  children as childrenApi, activity as activityApi,
  EmptyState, errorMessage, Icon, Pagination,
} from '@parentix/shared';
import ChildTabs from '../components/ChildTabs';
import PageIntro from '../components/PageIntro';

const LIMIT = 25;

const EMPTY_FILTERS = { from: '', to: '', search: '' };

/**
 * The sites a child's device has resolved.
 *
 * Records come from the device's DNS proxy, so this is a list of domains rather
 * than full addresses — there is no page or query string to show, which is
 * stated on the page so a parent is not left wondering where the rest went.
 */
export default function WebHistory() {
  const [childList, setChildList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [search, setSearch] = useState('');
  const [showDates, setShowDates] = useState(false);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    childrenApi.list()
      .then((r) => {
        setChildList(r.data);
        if (r.data[0]) setSelected(r.data[0]);
        else setLoading(false);
      })
      .catch(() => { setError('Could not load your children.'); setLoading(false); });
  }, []);

  // Typing in the search box should not fire a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => { setFilters((f) => ({ ...f, search })); setOffset(0); }, 350);
    return () => clearTimeout(id);
  }, [search]);

  const load = useCallback(() => {
    if (!selected) return;
    setLoading(true);
    setError('');
    activityApi.webHistory(selected.id, { limit: LIMIT, offset, ...filters })
      .then((r) => {
        setRows(r.data.rows || []);
        setTotal(r.data.count || 0);
        setTruncated(!!r.data.truncated);
      })
      .catch((err) => {
        // An error state of its own: an empty table with no explanation reads as
        // "this child browsed nothing", which is a different and wrong answer.
        setError(err.response?.data?.error || 'Could not load web history.');
        setRows([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  }, [selected, offset, filters]);

  useEffect(() => { load(); }, [load]);

  const hasFilters = !!(filters.from || filters.to || filters.search);
  const hasDateRange = !!(filters.from || filters.to);

  const clearAll = () => {
    setSearch('');
    setFilters(EMPTY_FILTERS);
    setOffset(0);
  };

  /**
   * Delete one recorded lookup.
   *
   * The domain goes in the prompt because the rows are dense and near-identical
   * — a list of `*.googleapis.com` a few pixels apart is exactly where a mis-tap
   * happens, and naming the row is what makes the dialog worth showing.
   */
  const removeRow = async (row) => {
    if (!confirm([
      'Delete this entry?',
      `${row.url || 'Unknown site'}\n${new Date(row.startTime).toLocaleString()}`,
      'This cannot be undone.',
    ].join('\n\n'))) return;
    setError('');
    try {
      await activityApi.removeEntry(selected.id, row.id);
      load();
    } catch (err) {
      setError(errorMessage(err, 'Could not delete that entry.'));
    }
  };

  /**
   * Clear the history — the date range included, and the search deliberately not.
   *
   * A search runs over decrypted values and a capped scan, so a search-scoped
   * delete could only remove what that scan happened to reach while reporting
   * success. The button is hidden while a search is active rather than offering
   * one that is quietly partial; the copy says to clear the search first.
   *
   * The prompt states that this also removes the rows from the Activity Log,
   * because it does — the two screens read one table — and a parent who found
   * out afterwards could not tell a deletion from a device that stopped
   * reporting.
   */
  const clearHistory = async () => {
    const scope = hasDateRange
      ? `the web history between ${filters.from || 'the beginning'} and ${filters.to || 'now'}`
      : "this child's entire web history";
    if (!confirm([
      `Delete ${scope}?`,
      'These entries also disappear from the Activity Log — they are the same records.',
      'This cannot be undone.',
    ].join('\n\n'))) return;

    setDeleting(true);
    setError('');
    try {
      const { data } = await activityApi.clearWebHistory(selected.id, {
        from: filters.from || undefined,
        to: filters.to || undefined,
      });
      setOffset(0);
      load();
      if (!data?.deleted) setError('There was nothing to delete.');
    } catch (err) {
      setError(errorMessage(err, 'Could not clear the web history.'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageIntro description="Sites looked up on your child's device.">
        <button onClick={load} className="btn-secondary btn-sm" disabled={loading}>
          <Icon name="refresh" size={15} />
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        {/* Hidden while a search is on: a search-scoped delete cannot be
            complete, so the button that promises one is not offered. */}
        {selected && rows.length > 0 && !filters.search && (
          <button
            onClick={clearHistory}
            disabled={deleting}
            className="btn-secondary btn-sm text-danger border-red-200 hover:bg-red-50 disabled:opacity-50"
          >
            <Icon name="trash" size={15} />
            {hasDateRange ? 'Clear range' : 'Clear all'}
          </button>
        )}
      </PageIntro>

      <ChildTabs
        items={childList}
        selectedId={selected?.id}
        onSelect={(c) => { setSelected(c); setOffset(0); }}
      />

      <div className="card">
        <div className="space-y-3 mb-4">
          <div className="flex gap-2">
            <label className="field flex-1 min-w-0">
              <span className="sr-only">Search domain</span>
              <input
                type="search"
                className="input"
                placeholder="Search a domain…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            {/* Date filters are the rarer need, so they stay folded away rather
                than taking a third of a phone screen before any result. */}
            <button
              onClick={() => setShowDates((v) => !v)}
              aria-expanded={showDates}
              className={`btn-secondary px-3 shrink-0 ${showDates ? 'border-primary-500 text-primary-600' : ''}`}
              aria-label="Filter by date"
            >
              <Icon name="calendar" size={18} />
            </button>
          </div>

          {showDates && (
            <div className="grid grid-cols-2 gap-3">
              <label className="field">
                <span className="field-label text-xs">From</span>
                <input
                  type="date" className="input" value={filters.from}
                  onChange={(e) => { setFilters((f) => ({ ...f, from: e.target.value })); setOffset(0); }}
                />
              </label>
              <label className="field">
                <span className="field-label text-xs">To</span>
                <input
                  type="date" className="input" value={filters.to}
                  onChange={(e) => { setFilters((f) => ({ ...f, to: e.target.value })); setOffset(0); }}
                />
              </label>
            </div>
          )}

          {hasFilters && (
            <button onClick={clearAll} className="btn-ghost btn-sm">Clear filters</button>
          )}
        </div>

        {error ? (
          <EmptyState
            icon="warning"
            title="Could not load web history"
            description={error}
            action={<button onClick={load} className="btn-primary">Try again</button>}
          />
        ) : loading ? (
          <p className="text-sm text-gray-400 text-center py-10">Loading web history…</p>
        ) : childList.length === 0 ? (
          <EmptyState
            icon="children"
            title="No child profiles yet"
            description="Add a child under Children to see their web history."
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="globe"
            title={hasFilters ? 'Nothing matches those filters' : 'No web history yet'}
            description={
              hasFilters
                ? 'Try a different date range or search term.'
                : 'History appears once the device has web monitoring enabled and the child browses.'
            }
          />
        ) : (
          <>
            {truncated && (
              <p className="notice-warning mb-3">
                <Icon name="warning" size={16} className="mt-0.5" />
                <span>
                  This history is long enough that the search only covered the most recent records.
                  Narrow the date range for a complete answer.
                </span>
              </p>
            )}
            <div className="space-y-2">
              {rows.map((row) => (
                <div key={row.id} className={`list-row ${row.blocked ? 'bg-red-50' : 'bg-gray-50'}`}>
                  <span className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                    row.blocked ? 'bg-white text-danger' : 'bg-white text-gray-500'
                  }`}>
                    <Icon name={row.blocked ? 'block' : 'globe'} size={18} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm text-gray-900 truncate">{row.url || 'Unknown site'}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {row.device?.name ? `${row.device.name} · ` : ''}
                      {new Date(row.startTime).toLocaleString()}
                    </p>
                  </div>
                  {/* The device has always reported which lookups its filter
                      stopped; until the API stored the flag there was nothing
                      to show here. */}
                  {row.blocked && (
                    <span className="badge-red shrink-0" title="A filter rule stopped this request">
                      Blocked
                    </span>
                  )}
                  {row.visitCount > 1 && (
                    <span className="badge-gray shrink-0" title="Times this site was requested">
                      ×{row.visitCount}
                    </span>
                  )}
                  <button
                    onClick={() => removeRow(row)}
                    className="icon-btn w-11 h-11 shrink-0 text-gray-400 hover:text-danger hover:bg-red-50"
                    aria-label={`Delete history entry for ${row.url || 'unknown site'}`}
                    title="Delete this entry"
                  >
                    <Icon name="trash" size={17} />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {!error && (
          <Pagination
            offset={offset}
            limit={LIMIT}
            count={total}
            onChange={setOffset}
            label="sites"
            disabled={loading}
          />
        )}
      </div>

      <p className="text-xs text-gray-400">
        Parentix records the sites a device looks up, not the individual pages within them.
      </p>
    </div>
  );
}
