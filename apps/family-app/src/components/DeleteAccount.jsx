import { useState } from 'react';
import { useAuth, auth as authApi, errorMessage, Icon, Modal } from '@parentix/shared';

/**
 * Closing the account, and erasing what it holds.
 *
 * There was no way to do this anywhere in the product. For a service that stores
 * a child's location history, contacts and browsing that is a legal problem —
 * the right to erasure — before it is a missing feature, and Google Play
 * requires an in-app route to it for any app that lets you create an account,
 * which the family app does.
 *
 * The confirmation is deliberately two steps and typed rather than clicked. This
 * deletes the children's histories as well as the parent's login, and there is
 * no undo on the other side of it.
 */
export default function DeleteAccount() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // A Google or phone-only account has no password to re-enter, so it types the
  // word instead. Something deliberate has to happen either way.
  const hasPassword = user?.hasPassword !== false;
  const ready = hasPassword ? password.length > 0 : confirm.trim().toUpperCase() === 'DELETE';

  const close = () => {
    setOpen(false);
    setPassword('');
    setConfirm('');
    setError('');
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await authApi.deleteAccount(hasPassword ? { password } : { confirm: confirm.trim() });
      // The token is dead server-side; clearing it locally is what stops the
      // next render from bouncing through a 401 on the way to /login.
      await logout();
      window.location.replace('/login');
    } catch (err) {
      setError(errorMessage(err, 'Could not delete your account.'));
      setBusy(false);
    }
  };

  return (
    <div className="card border-red-100">
      <h2 className="section-title mb-1 text-danger">Delete this account</h2>
      <p className="text-sm text-gray-500 mb-4">
        Permanently removes your account and every child profile on it — devices, locations, messages,
        contacts, alerts and activity history. Linked phones stop reporting immediately. This cannot
        be undone.
      </p>
      <button onClick={() => setOpen(true)} className="btn-danger btn-block sm:w-auto">
        <Icon name="trash" size={16} />
        Delete account
      </button>

      <Modal
        open={open}
        onClose={close}
        title="Delete your account?"
        description="Everything below goes with it, for every child on the account."
      >
        <form onSubmit={submit} className="space-y-4">
          <ul className="text-sm text-gray-600 space-y-1.5">
            {[
              'Every child profile and their linked devices',
              'All location history and safe zones',
              'All messages, contacts and alerts',
              'All screen-time rules and blocking rules',
              'Your subscription, which is cancelled first',
            ].map((line) => (
              <li key={line} className="flex items-start gap-2">
                <Icon name="warning" size={15} className="text-danger mt-0.5 shrink-0" />
                <span>{line}</span>
              </li>
            ))}
          </ul>

          {hasPassword ? (
            <label className="field">
              <span className="field-label">Confirm your password</span>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
          ) : (
            <label className="field">
              <span className="field-label">Type DELETE to confirm</span>
              <input
                className="input"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="DELETE"
                required
              />
            </label>
          )}

          {error && <p className="notice-error">{error}</p>}

          <div className="flex flex-col sm:flex-row gap-2">
            <button type="submit" className="btn-danger btn-block" disabled={busy || !ready}>
              {busy ? 'Deleting…' : 'Delete my account for good'}
            </button>
            <button type="button" onClick={close} className="btn-secondary btn-block" disabled={busy}>
              Keep my account
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
