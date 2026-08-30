import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { admin as adminApi, errorMessage, EmptyState, Icon } from '@parentix/shared';
import DataTable from '../components/DataTable';
import StatTile from '../components/StatTile';

/**
 * Contact Messages — everything the public form has ever received.
 *
 * The form stores the message before it tries to email anyone, so a dead relay
 * or a spam verdict costs the notification and never the message. Until this
 * screen existed there was no way to collect on that: the rows were written,
 * matched against for duplicates, deleted by account erasure, and shown to
 * nobody. An operator reporting "I get no contact emails" had a backlog they
 * could not see.
 *
 * Three states matter and the tiles lead with them, because each is a different
 * job. `failed` is the urgent one — somebody wrote in and nobody was told — and
 * it is the only tile that turns red. `spam` is the one to audit occasionally: a
 * refusal is deliberately invisible to the sender, so a false positive is a
 * customer who believes they reached support and did not.
 *
 * Filters are query parameters, not row filtering in the browser, so the count
 * under the table and the paginator beside it describe the same set the filters
 * do. The summary tiles are the deliberate exception: they count the whole inbox
 * and ignore every filter, as the user and device directories do — narrowing to
 * `failed` must not make "12 failed" become "12 of 12".
 */

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 350;

/**
 * How each state is drawn, and what it actually means.
 *
 * `row` tints the table stripe and is reserved for `failed`: a stripe on every
 * row is wallpaper, and this is the one state that wants attention.
 */
const STATUSES = {
  new: {
    label: 'New',
    badge: 'bg-primary-50 text-primary-700',
    row: '',
    hint: 'Stored. The notification has not been recorded yet.',
  },
  notified: {
    label: 'Notified',
    badge: 'bg-green-100 text-green-700',
    row: '',
    hint: 'The operator mailbox has it.',
  },
  failed: {
    label: 'Failed',
    badge: 'bg-red-100 text-red-700',
    row: 'bg-red-50/40',
    hint: 'Nobody was told. The message is safe — retry once mail is working.',
  },
  spam: {
    label: 'Spam',
    badge: 'bg-amber-100 text-amber-800',
    row: '',
    hint: 'Held by the spam checks. No email was ever attempted.',
  },
  archived: {
    label: 'Archived',
    badge: 'bg-gray-100 text-gray-600',
    row: '',
    hint: 'Dealt with.',
  },
};

const statusOf = (row) => STATUSES[row.status] || STATUSES.new;

const FILTERS = [
  { value: '', label: 'All messages' },
  { value: 'failed', label: 'Failed to notify' },
  { value: 'new', label: 'New' },
  { value: 'notified', label: 'Notified' },
  { value: 'spam', label: 'Spam' },
  { value: 'archived', label: 'Archived' },
];

const formatWhen = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
};

export default function ContactMessages() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || '';
  const page = Math.max(1, Number(params.get('page')) || 1);

  const [rows, setRows] = useState([]);
  const [count, setCount] = useState(0);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [expanded, setExpanded] = useState(null);

  // The box is uncontrolled by the URL while you type: writing every keystroke
  // into the query string would put a history entry behind each letter.
  const [search, setSearch] = useState(params.get('q') || '');
  const debounce = useRef(null);
  const q = params.get('q') || '';

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await adminApi.listContactMessages({
        ...(q ? { q } : {}),
        ...(status ? { status } : {}),
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      setRows(Array.isArray(data?.rows) ? data.rows : []);
      setCount(data?.count || 0);
      setSummary(data?.summary || null);
    } catch (err) {
      // A failed load is never rendered as an empty inbox: "no messages" and
      // "we could not ask" are opposite answers to the operator's question.
      setError(errorMessage(err, 'Could not load contact messages.'));
      setRows([]);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [q, status, page]);

  useEffect(() => { load(); }, [load]);

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    // Any change to what is being looked at returns to the first page — page 4
    // of a filter that matches two rows is an empty screen with no explanation.
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const onSearch = (value) => {
    setSearch(value);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setParam('q', value.trim()), SEARCH_DEBOUNCE_MS);
  };

  const resend = async (row) => {
    setBusyId(row.id); setNotice(''); setError('');
    try {
      const { data } = await adminApi.resendContactNotification(row.id);
      // The reason matters more than the outcome when it fails again — it is
      // the relay's own words, and it is what says whether to keep trying.
      setNotice(data.delivered
        ? `Notification for ${row.email} was delivered.`
        : `Still could not notify anyone about ${row.email}${data.deliveryError ? ` — ${data.deliveryError}` : ''}.`);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not retry that notification.'));
    } finally {
      setBusyId(null);
    }
  };

  const setStatus = async (row, next) => {
    setBusyId(row.id); setNotice(''); setError('');
    try {
      await adminApi.setContactMessageStatus(row.id, next);
      setNotice(next === 'new'
        ? `${row.email} is back in the queue. Retry the notification to send it on.`
        : `Message from ${row.email} archived.`);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not update that message.'));
    } finally {
      setBusyId(null);
    }
  };

  const columns = [
    {
      key: 'from',
      header: 'From',
      primary: true,
      cell: (row) => (
        <div className="min-w-0 max-w-[14rem] xl:max-w-xs">
          <p className="font-medium text-gray-900 truncate">{row.name}</p>
          <p className="text-xs text-gray-500 truncate">{row.email}</p>
        </div>
      ),
    },
    {
      key: 'message',
      header: 'Message',
      cell: (row) => (
        <button
          type="button"
          onClick={() => setExpanded(expanded === row.id ? null : row.id)}
          className="text-left text-sm text-gray-600 hover:text-primary-600 max-w-md"
          aria-expanded={expanded === row.id}
        >
          <span className={expanded === row.id ? 'whitespace-pre-wrap' : 'line-clamp-2'}>
            {row.message}
          </span>
        </button>
      ),
    },
    {
      key: 'status',
      header: 'State',
      cell: (row) => {
        const state = statusOf(row);
        return (
          <div className="min-w-0">
            <span className={`badge ${state.badge}`}>{state.label}</span>
            {/* The reason, whichever kind it is. Both are the answer to "why did
                nobody get this", and neither is guessable from the badge. */}
            {(row.deliveryError || row.spamReason) && (
              <p className="text-xs text-gray-400 mt-1 truncate max-w-[12rem]" title={row.deliveryError || row.spamReason}>
                {row.deliveryError || row.spamReason}
              </p>
            )}
          </div>
        );
      },
    },
    {
      key: 'received',
      header: 'Received',
      cell: (row) => (
        <span className="text-sm text-gray-500 whitespace-nowrap">{formatWhen(row.createdAt)}</span>
      ),
    },
  ];

  const actions = (row) => (
    <div className="flex items-center gap-1 lg:gap-0.5">
      <a
        href={`mailto:${row.email}?subject=${encodeURIComponent('Re: your message to Parentix')}`}
        className="btn-ghost btn-sm lg:w-9 lg:px-0 justify-center"
        aria-label={`Reply to ${row.email}`}
        title="Reply by email"
      >
        <Icon name="send" size={16} />
        <span className="lg:hidden ml-1.5">Reply</span>
      </a>
      {row.status !== 'spam' && (
        <button
          type="button"
          onClick={() => resend(row)}
          disabled={busyId === row.id}
          className="btn-ghost btn-sm lg:w-9 lg:px-0 justify-center"
          aria-label={`Retry the notification for ${row.email}`}
          title="Retry notification"
        >
          <Icon name="refresh" size={16} />
          <span className="lg:hidden ml-1.5">Retry</span>
        </button>
      )}
      {row.status === 'spam' && (
        <button
          type="button"
          onClick={() => setStatus(row, 'new')}
          disabled={busyId === row.id}
          // `whitespace-nowrap` because this is the one text action in the
          // column: without it "Not spam" wraps to two lines inside the narrow
          // action cell, which is the wrapped-control fault the browser suite
          // guards the other console tables against.
          className="btn-ghost btn-sm lg:w-auto lg:px-2 justify-center whitespace-nowrap"
          title="This is not spam"
        >
          Not spam
        </button>
      )}
      {row.status !== 'archived' && (
        <button
          type="button"
          onClick={() => setStatus(row, 'archived')}
          disabled={busyId === row.id}
          className="btn-ghost btn-sm lg:w-9 lg:px-0 justify-center"
          aria-label={`Archive the message from ${row.email}`}
          title="Archive"
        >
          <Icon name="check" size={16} />
          <span className="lg:hidden ml-1.5">Archive</span>
        </button>
      )}
    </div>
  );

  return (
    <div className="space-y-5">
      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <StatTile label="Total received" value={summary.total} icon="inbox" />
          <StatTile label="Awaiting notice" value={summary.new} icon="clock" />
          <StatTile
            label="Never delivered"
            value={summary.failed}
            icon="warning"
            alert={summary.failed > 0}
          />
          <StatTile label="Held as spam" value={summary.spam} icon="block" />
        </div>
      )}

      {summary?.failed > 0 && (
        <p className="notice notice-error">
          <Icon name="warning" size={16} className="mt-0.5" />
          <span>
            {summary.failed} {summary.failed === 1 ? 'message was' : 'messages were'} stored but never
            announced to anyone. The messages are intact — fix the mail relay, then use Retry.
          </span>
        </p>
      )}

      {notice && <p className="notice-success">{notice}</p>}
      {error && <p className="notice-error">{error}</p>}

      <DataTable
        dense
        title="Contact form"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        rowClass={(row) => statusOf(row).row}
        actions={actions}
        loading={loading}
        loadingLabel="Loading contact messages…"
        toolbar={(
          <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
            <label className="relative flex-1 sm:w-64">
              <span className="sr-only">Search contact messages</span>
              <Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                className="input pl-9"
                placeholder="Name, address or message"
                value={search}
                onChange={(e) => onSearch(e.target.value)}
              />
            </label>
            <label className="sm:w-52">
              <span className="sr-only">Filter by state</span>
              <select className="input" value={status} onChange={(e) => setParam('status', e.target.value)}>
                {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </label>
          </div>
        )}
        empty={(
          <EmptyState
            icon="inbox"
            title={q || status ? 'No messages match that' : 'No messages yet'}
            description={
              q || status
                ? 'Try a different search, or widen the state filter.'
                : 'When somebody writes in through the contact form on the website, it appears here — whether or not the notification email goes out.'
            }
          />
        )}
        // The shared paginator counts in offsets, not pages, and hands `onChange`
        // an offset back — the URL keeps a page number because that is what a
        // person reads in a shared link.
        pagination={{
          offset: (page - 1) * PAGE_SIZE,
          limit: PAGE_SIZE,
          count,
          disabled: loading,
          label: 'messages',
          onChange: (offset) => {
            const next = Math.floor(offset / PAGE_SIZE) + 1;
            setParam('page', next > 1 ? String(next) : '');
          },
        }}
      />
    </div>
  );
}
