import { useState } from 'react';
import { mfa as mfaApi } from '../api/endpoints.js';
import { errorMessage } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';

/**
 * Turning two-factor authentication on and off.
 *
 * The API has supported TOTP, QR provisioning and backup codes since before
 * either app shipped, but nothing ever called `/mfa/setup` — the login challenge
 * was the only part reachable, so no account could enable MFA in the first
 * place. This is that missing screen, shared because the parent app and the
 * staff console both need it and the flow is identical.
 *
 * `/mfa/setup` returns a ready-made QR data URL, so no client-side QR library is
 * involved.
 */
export default function TwoFactorSetup() {
  const { user, setUser } = useAuth();
  // 'idle' → 'scanning' (secret issued, awaiting first code) → 'codes' (backup codes shown)
  const [stage, setStage] = useState('idle');
  const [setupData, setSetupData] = useState(null);
  const [backupCodes, setBackupCodes] = useState(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const enabled = !!user?.mfaEnabled;

  const reset = () => {
    setStage('idle');
    setSetupData(null);
    setBackupCodes(null);
    setCode('');
    setPassword('');
    setError('');
  };

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const beginSetup = () => run(async () => {
    const res = await mfaApi.setup();
    setSetupData(res.data);
    setStage('scanning');
  });

  const confirmSetup = () => run(async () => {
    const res = await mfaApi.enable({ code: code.trim() });
    setBackupCodes(res.data.backupCodes);
    setStage('codes');
    setCode('');
    // The session's user object still says MFA is off until this is reflected.
    setUser((prev) => (prev ? { ...prev, mfaEnabled: true } : prev));
  });

  const turnOff = () => run(async () => {
    await mfaApi.disable({ password, code: code.trim() });
    setUser((prev) => (prev ? { ...prev, mfaEnabled: false } : prev));
    reset();
    setNotice('Two-factor authentication is off.');
  });

  return (
    <div className="card">
      <div className="flex items-start justify-between gap-4 mb-1">
        <h2 className="font-semibold">Two-Factor Authentication</h2>
        <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
          {enabled ? 'On' : 'Off'}
        </span>
      </div>
      <p className="text-gray-500 text-sm mb-4">
        {enabled
          ? 'A code from your authenticator app is required each time you sign in.'
          : 'Protect your account with a code from an authenticator app, in addition to your password.'}
      </p>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {notice && !error && <p className="text-sm text-green-600 mb-3">{notice}</p>}

      {/* ── Backup codes, shown once ───────────────────────────────────────── */}
      {stage === 'codes' && backupCodes && (
        <div className="space-y-3">
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
            <p className="text-sm font-medium text-amber-900">Save these backup codes now</p>
            <p className="text-xs text-amber-800 mt-1">
              Each one signs you in once if you lose your authenticator. They are not shown again.
            </p>
          </div>
          <ul className="grid grid-cols-2 gap-2 font-mono text-sm">
            {backupCodes.map((c) => (
              <li key={c} className="bg-gray-50 rounded-lg px-3 py-2 text-center tracking-wider">{c}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-ghost text-sm"
              onClick={() => navigator.clipboard?.writeText(backupCodes.join('\n'))}
            >
              Copy codes
            </button>
            <button type="button" className="btn-primary" onClick={() => { reset(); setNotice('Two-factor authentication is on.'); }}>
              Done
            </button>
          </div>
        </div>
      )}

      {/* ── Scan and confirm ───────────────────────────────────────────────── */}
      {stage === 'scanning' && setupData && (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Scan this with your authenticator app, then enter the six-digit code it shows.
          </p>
          <img src={setupData.qrCode} alt="Two-factor setup QR code" className="w-44 h-44 rounded-xl border border-gray-100" />
          <details className="text-xs text-gray-500">
            <summary className="cursor-pointer">Can&apos;t scan it?</summary>
            <p className="mt-1">
              Enter this key by hand: <code className="font-mono break-all">{setupData.secret}</code>
            </p>
          </details>
          <label className="block">
            <span className="text-sm text-gray-500">Six-digit code</span>
            <input
              className="input mt-1 font-mono tracking-widest"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
            />
          </label>
          <div className="flex gap-2">
            <button type="button" className="btn-primary" onClick={confirmSetup} disabled={busy || code.trim().length < 6}>
              {busy ? 'Verifying…' : 'Verify and turn on'}
            </button>
            <button type="button" className="btn-ghost text-sm" onClick={reset} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── Off, and not mid-setup ─────────────────────────────────────────── */}
      {stage === 'idle' && !enabled && (
        <button type="button" className="btn-primary" onClick={beginSetup} disabled={busy}>
          {busy ? 'Preparing…' : 'Turn on two-factor'}
        </button>
      )}

      {/* ── On ─────────────────────────────────────────────────────────────── */}
      {stage === 'idle' && enabled && (
        <details>
          <summary className="cursor-pointer text-sm text-red-600">Turn off two-factor</summary>
          {/* Both are required by the API: knowing the password alone must not be
              enough to strip the second factor off a hijacked session. */}
          <div className="space-y-3 mt-3">
            <label className="block">
              <span className="text-sm text-gray-500">Your password</span>
              <input className="input mt-1" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
            <label className="block">
              <span className="text-sm text-gray-500">Six-digit code</span>
              <input
                className="input mt-1 font-mono tracking-widest"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="123456"
              />
            </label>
            <button type="button" className="btn-danger" onClick={turnOff} disabled={busy || !password || code.trim().length < 6}>
              {busy ? 'Turning off…' : 'Turn off'}
            </button>
          </div>
        </details>
      )}
    </div>
  );
}
