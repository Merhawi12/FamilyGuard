import { useCallback, useEffect, useState } from 'react';
import { auth as authApi, errorMessage, timeAgo, EmptyState, Icon } from '@parentix/shared';

/**
 * Where this account is signed in, and how to end any of it.
 *
 * The platform emails the account holder as soon as their account is opened from
 * a device it has not seen before. That message told them to change their
 * password, which is the only lever the product had — and it signs out the phone
 * they are reading the email on along with whoever they are trying to evict.
 * This is the screen that message assumes exists.
 */

/**
 * A user agent string turned into something a person can recognise.
 *
 * Deliberately coarse. The aim is only to let someone match a row against a
 * device they own; a full UA string is unreadable and the parts of it that are
 * precise are the parts nobody can act on.
 */
const describeAgent = (ua) => {
  if (!ua) return 'Unknown device';

  const browser =
    /Edg\//.test(ua) ? 'Edge'
      : /OPR\/|Opera/.test(ua) ? 'Opera'
        : /Chrome\//.test(ua) ? 'Chrome'
          : /Firefox\//.test(ua) ? 'Firefox'
            : /Safari\//.test(ua) ? 'Safari'
              : null;

  const platform =
    /Android/.test(ua) ? 'Android'
      : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
        : /Windows/.test(ua) ? 'Windows'
          : /Macintosh|Mac OS/.test(ua) ? 'macOS'
            : /Linux/.test(ua) ? 'Linux'
              : null;

  if (browser && platform) return `${browser} on ${platform}`;
  if (browser || platform) return browser || platform;
  // Not a browser at all — a linked phone, a script. Show what it said, capped.
  return ua.length > 40 ? `${ua.slice(0, 40)}…` : ua;
};

/**
 * Reads inside "Active …", so it stays lowercase and short — the line it sits on
 * already carries an IP address and has to survive a phone-width column.
 */
const when = (value) => timeAgo(value, { absent: 'Unknown', compact: true });

export default function ActiveSessions() {
  const [sessions, setSessions] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(() => {
    setError('');
    return authApi.sessions()
      .then((r) => setSessions(r.data))
      // An empty list and a failed request are different answers, and this is a
      // security screen — "no other devices" must never be a rendering of "we
      // could not ask".
      .catch((err) => setError(errorMessage(err, 'Could not load your signed-in devices.')));
  }, []);

  useEffect(() => { load(); }, [load]);

  const revokeOne = async (id) => {
    setBusy(id); setError(''); setMessage('');
    try {
      const res = await authApi.revokeSession(id);
      setMessage(res.data?.message || 'That device has been signed out.');
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not sign that device out.'));
    } finally {
      setBusy('');
    }
  };

  const revokeOthers = async () => {
    setBusy('others'); setError(''); setMessage('');
    try {
      const res = await authApi.revokeOtherSessions();
      setMessage(res.data?.message || 'Other devices have been signed out.');
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not sign the other devices out.'));
    } finally {
      setBusy('');
    }
  };

  const others = (sessions || []).filter((s) => !s.current);

  return (
    <div className="card">
      <div className="flex items-start justify-between gap-3 mb-1">
        <h2 className="section-title">Signed-in devices</h2>
        {others.length > 0 && (
          <button
            onClick={revokeOthers}
            disabled={busy === 'others'}
            className="btn-secondary btn-sm shrink-0"
          >
            {busy === 'others' ? 'Signing out…' : 'Sign out others'}
          </button>
        )}
      </div>
      <p className="text-sm text-gray-500 mb-3">
        Everywhere this account is currently signed in. If you do not recognise one, sign it out and
        change your password.
      </p>

      {error && <p className="notice-error mb-3">{error}</p>}
      {message && <p className="notice-success mb-3">{message}</p>}

      {!sessions ? (
        error ? (
          <button onClick={load} className="btn-secondary btn-block sm:w-auto">Try again</button>
        ) : (
          <p className="text-sm text-gray-400">Loading your devices…</p>
        )
      ) : sessions.length === 0 ? (
        <EmptyState compact icon="lock" title="No other devices" />
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => (
            <div key={s.id} className="list-row bg-gray-50">
              <span className="w-9 h-9 rounded-xl bg-white text-gray-500 flex items-center justify-center shrink-0">
                <Icon name="phone" size={18} />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {describeAgent(s.userAgent)}
                  {s.current && <span className="badge-primary ml-2">This device</span>}
                </p>
                <p className="text-xs text-gray-500 truncate">
                  {s.ipAddress || 'Unknown address'} · Active {when(s.lastActiveAt)}
                </p>
              </div>
              {!s.current && (
                <button
                  onClick={() => revokeOne(s.id)}
                  disabled={busy === s.id}
                  className="btn-ghost btn-sm shrink-0 text-danger"
                >
                  {busy === s.id ? 'Signing out…' : 'Sign out'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
