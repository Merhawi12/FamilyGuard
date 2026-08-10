import { useCallback, useEffect, useState } from 'react';
import { notifications as notificationsApi, Icon, Toggle } from '@parentix/shared';
import {
  enablePush,
  disablePush,
  isSubscribed,
  permissionState,
  pushSupported,
  isNativeApp,
  refreshNativePermission,
} from '../services/push';

/**
 * Turning notifications on and off, and saying plainly why they are unavailable
 * when they are.
 *
 * Four different things stop a push arriving — the device cannot do it, the
 * deployment has no keys, the parent denied permission, or they simply have not
 * subscribed — and each needs a different response from the parent. Collapsing
 * them into one "notifications off" toggle is what leaves someone toggling a
 * switch that cannot help them.
 *
 * The wording differs between the Android app and a browser because the remedy
 * does: "allow them in your browser settings" is useless advice on a phone, where
 * the switch is in Android's own app settings.
 */
const REASONS = {
  web: {
    unsupported: 'This browser does not support notifications. Try Chrome, Edge or Firefox on desktop or Android.',
    'not-configured': 'Push notifications are not enabled on this Parentix deployment yet.',
    denied: 'Notifications are blocked for this site. Allow them in your browser settings, then try again.',
    dismissed: 'The permission prompt was dismissed. Try again when you are ready.',
    failed: 'Something went wrong turning notifications on.',
  },
  native: {
    unsupported: 'This device cannot receive notifications.',
    'not-configured': 'Push notifications are not enabled on this Parentix deployment yet.',
    denied: 'Notifications are turned off for Parentix. Turn them on in Android Settings → Apps → Parentix → Notifications, then try again.',
    dismissed: 'The permission prompt was dismissed. Try again when you are ready.',
    failed: 'Something went wrong turning notifications on.',
  },
};

export default function PushSettings() {
  const native = isNativeApp();
  const reasons = native ? REASONS.native : REASONS.web;
  // What the row in the list is, in the parent's words. The same table holds a
  // browser and a phone once the Android app can register.
  const noun = native ? 'device' : 'browser';

  const [available, setAvailable] = useState(null); // null = still checking
  const [subscribed, setSubscribed] = useState(false);
  const [permission, setPermission] = useState(permissionState());
  const [devices, setDevices] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState('');

  const refresh = useCallback(async () => {
    // On Android the permission is behind an async plugin call, so the
    // synchronous read is a placeholder until this resolves it.
    setPermission(native ? await refreshNativePermission() : permissionState());
    setSubscribed(await isSubscribed());
    notificationsApi.pushSubscriptions().then((r) => setDevices(r.data)).catch(() => setDevices([]));
  }, [native]);

  useEffect(() => {
    if (!pushSupported()) { setAvailable(false); setProblem(reasons.unsupported); return; }
    notificationsApi.pushConfig()
      .then((r) => {
        // Two different capabilities behind one screen: VAPID keys for a
        // browser, FCM for the app. A deployment can have one and not the other.
        const usable = native ? r.data.fcmAvailable : r.data.available;
        setAvailable(!!usable);
        if (!usable) setProblem(reasons['not-configured']);
      })
      .catch(() => { setAvailable(false); setProblem(reasons['not-configured']); });
    refresh();
  }, [refresh, native, reasons]);

  const toggle = async () => {
    setBusy(true); setMessage(''); setProblem('');
    const result = subscribed ? await disablePush() : await enablePush();
    if (result.ok) {
      setMessage(subscribed
        ? `Notifications turned off for this ${noun}.`
        : `Notifications are on for this ${noun}.`);
    } else {
      setProblem(reasons[result.reason] || reasons.failed);
    }
    await refresh();
    setBusy(false);
  };

  const test = async () => {
    setBusy(true); setMessage(''); setProblem('');
    try {
      const { data } = await notificationsApi.pushTest();
      setMessage(
        data.sent > 0
          ? `Test notification sent to ${data.sent} of ${data.recipients} registered device(s).`
          : 'The test was accepted but nothing confirmed delivery — check the list below.'
      );
    } catch (err) {
      setProblem(err.response?.data?.error || 'Could not send the test notification.');
    }
    await refresh();
    setBusy(false);
  };

  const forget = async (id) => {
    await notificationsApi.pushRemoveSubscription(id).catch(() => {});
    await refresh();
  };

  const status = available === null ? 'Checking…'
    : !available ? 'Unavailable'
    : permission === 'denied' ? (native ? 'Blocked in Android settings' : 'Blocked in browser settings')
    : subscribed ? 'On' : 'Off';

  return (
    <div className="card">
      <h2 className="section-title mb-1">Notifications</h2>
      <p className="text-sm text-gray-500 mb-2">
        {native
          ? 'Get alerts on this phone even when Parentix is closed.'
          : 'Get alerts on this device even when the Parentix tab is closed.'}
      </p>

      <Toggle
        label={`Notifications on this ${noun}`}
        description={status}
        checked={subscribed}
        disabled={busy || !available || permission === 'denied'}
        onChange={toggle}
      />

      {message && <p className="notice-success mt-3">{message}</p>}
      {problem && (
        <p className="notice-warning mt-3">
          <Icon name="warning" size={16} className="mt-0.5 shrink-0" />
          <span>{problem}</span>
        </p>
      )}

      {subscribed && (
        <button onClick={test} disabled={busy} className="btn-secondary btn-sm mt-3">
          Send a test notification
        </button>
      )}

      {devices.length > 0 && (
        <div className="mt-5 pt-4 border-t border-gray-100">
          {/* One parent can have several: a desktop browser, a phone browser and
              the Android app are three separate registrations. */}
          <p className="text-sm font-medium text-gray-900 mb-2">Where you get notifications</p>
          <div className="space-y-1">
            {devices.map((d) => (
              <div key={d.id} className="flex items-center gap-3 min-h-[44px]">
                <span className={`w-2 h-2 rounded-full shrink-0 ${d.isActive ? 'bg-success' : 'bg-gray-300'}`} />
                <span className="flex-1 min-w-0 truncate text-sm text-gray-600">
                  {d.label || 'Unnamed device'}
                  {!d.isActive && <span className="text-gray-400"> · stopped working</span>}
                </span>
                <button
                  onClick={() => forget(d.id)}
                  className="icon-btn w-9 h-9 text-gray-400 hover:text-danger"
                  aria-label={`Remove ${d.label || 'this device'}`}
                >
                  <Icon name="trash" size={16} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
