import { useEffect, useState } from 'react';
import {
  children as childrenApi, blocking as blockingApi,
  errorMessage, EmptyState, Icon, CONTENT_CATEGORIES, categoryLabel,
} from '@parentix/shared';
import ChildTabs from '../components/ChildTabs';
import PageIntro from '../components/PageIntro';

const POPULAR_APPS = [
  { name: 'TikTok', package: 'com.zhiliaoapp.musically' },
  { name: 'Instagram', package: 'com.instagram.android' },
  { name: 'YouTube', package: 'com.google.android.youtube' },
  { name: 'Snapchat', package: 'com.snapchat.android' },
  { name: 'WhatsApp', package: 'com.whatsapp' },
  { name: 'PUBG Mobile', package: 'com.tencent.ig' },
];

/**
 * The categories a device can really enforce.
 *
 * It was a hand-written list here, and one entry on it — `violence` — could
 * never be blocked: the phone filters DNS names, and there is no list of names
 * that means "violence". Blocking it did nothing at all. The catalogue is now
 * the server's, expanded into domains when the device fetches its rules.
 */
const WEBSITE_CATEGORIES = CONTENT_CATEGORIES;

/**
 * What an app rule can be.
 *
 * "Allow only" used to sit here too. Nothing implemented it — not the API, not
 * the phone — so choosing it produced a rule that showed up in the list with a
 * badge and changed nothing. It is gone rather than fixed, because for apps it
 * means blocking every other app on the phone including the dialer, and the
 * device has no way to express an exception. Website whitelisting, which is a
 * different feature and is implemented, is still on the Websites side.
 */
const APP_ACTIONS = [
  { value: 'block', label: 'Block completely' },
  { value: 'limit', label: 'Limit time per day' },
];

const DEFAULT_APP_LIMIT = 60;

const EMPTY_APP_FORM = {
  appName: '', appPackage: '', action: 'block', dailyLimitMinutes: String(DEFAULT_APP_LIMIT),
};

export default function AppBlocking() {
  const [childList, setChildList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [view, setView] = useState('apps'); // phone only; both columns show from lg
  const [appRules, setAppRules] = useState([]);
  const [webRules, setWebRules] = useState([]);
  // The apps this child's devices have reported. A rule is enforced by package
  // name and a parent has no way to know one, so the form offers what the phone
  // has actually seen and fills the package in.
  const [knownApps, setKnownApps] = useState([]);
  const [appForm, setAppForm] = useState(EMPTY_APP_FORM);
  const [webForm, setWebForm] = useState({ url: '', category: 'custom', action: 'block' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    childrenApi.list()
      .then((r) => { setChildList(r.data); if (r.data[0]) setSelected(r.data[0]); })
      .catch(() => setError('Could not load your children.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selected) return;
    // An empty rule list reads as "nothing is blocked for this child" — the
    // opposite of the truth when the request simply failed, and the reading a
    // parent is most likely to act on.
    setError('');
    blockingApi.getApps(selected.id)
      .then((r) => setAppRules(r.data))
      .catch((err) => { setAppRules([]); setError(errorMessage(err, 'Could not load the blocking rules.')); });
    // Advisory: a device that has never reported usage simply offers no list,
    // and the manual package field still works. Not worth an error banner.
    blockingApi.knownApps(selected.id)
      .then((r) => setKnownApps(r.data))
      .catch(() => setKnownApps([]));
    blockingApi.getWebsites(selected.id)
      .then((r) => setWebRules(r.data))
      // Website filtering is plan-gated, so a 403 here is an entitlement answer
      // rather than a failure — the upgrade prompt below already explains it.
      .catch((err) => {
        setWebRules([]);
        if (err?.response?.status !== 403) setError(errorMessage(err, 'Could not load the website rules.'));
      });
  }, [selected]);

  // Every mutation went out unguarded; a rejected request became an unhandled
  // promise rejection and the parent saw nothing at all happen.
  const run = async (fn, fallback) => {
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err, fallback));
    }
  };

  const addApp = (app) => run(async () => {
    const data = app
      ? { appName: app.name, appPackage: app.package, action: 'block' }
      : {
        appName: appForm.appName.trim(),
        appPackage: appForm.appPackage.trim(),
        action: appForm.action,
        ...(appForm.action === 'limit'
          ? { dailyLimitMinutes: parseInt(appForm.dailyLimitMinutes, 10) }
          : {}),
      };
    const r = await blockingApi.addApp(selected.id, data);
    setAppRules((prev) => [...prev, r.data]);
    if (!app) setAppForm(EMPTY_APP_FORM);
  }, 'Could not add that app rule.');

  /** Picking a reported app fills in both halves; "—" goes back to typing them. */
  const chooseKnownApp = (appPackage) => {
    const match = knownApps.find((a) => a.appPackage === appPackage);
    setAppForm((f) => ({
      ...f,
      appPackage,
      appName: match ? match.appName : f.appName,
    }));
  };

  const removeApp = (ruleId) => run(async () => {
    await blockingApi.removeApp(selected.id, ruleId);
    setAppRules((prev) => prev.filter((r) => r.id !== ruleId));
  }, 'Could not remove that app rule.');

  const addWebsite = (e) => {
    e?.preventDefault();
    return run(async () => {
      const r = await blockingApi.addWebsite(selected.id, { ...webForm, url: webForm.url.trim() });
      setWebRules((prev) => [...prev, r.data]);
      setWebForm({ url: '', category: 'custom', action: 'block' });
    }, 'Could not add that website rule.');
  };

  const addCategory = (category) => run(async () => {
    const r = await blockingApi.addWebsite(selected.id, { category, action: 'block' });
    setWebRules((prev) => [...prev, r.data]);
  }, 'Could not block that category.');

  const removeWebsite = (ruleId) => run(async () => {
    await blockingApi.removeWebsite(selected.id, ruleId);
    setWebRules((prev) => prev.filter((r) => r.id !== ruleId));
  }, 'Could not remove that website rule.');

  if (loading) return <p className="text-sm text-gray-400 py-8">Loading…</p>;

  if (childList.length === 0) {
    return (
      <div className="card">
        <EmptyState
          icon="block"
          title="No child profiles yet"
          description="Add a child and link their device before setting up blocking rules."
          action={<a href="/dashboard/children" className="btn-primary">Go to Children</a>}
        />
      </div>
    );
  }

  const ruleRow = (key, title, subtitle, action, onRemove) => (
    <div key={key} className="list-row bg-gray-50">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">{title}</p>
        <p className="text-xs text-gray-500 truncate">{subtitle}</p>
      </div>
      {/* Three outcomes, not two: blocked, explicitly allowed, and capped. A
          time cap reading as green ("allow") said the opposite of what it does. */}
      <span className={action === 'block' ? 'badge-red' : action === 'allow' ? 'badge-green' : 'badge-amber'}>
        {action}
      </span>
      <button
        onClick={onRemove}
        className="icon-btn w-9 h-9 text-gray-400 hover:text-danger"
        aria-label={`Remove rule for ${title}`}
      >
        <Icon name="trash" size={16} />
      </button>
    </div>
  );

  return (
    <div className="space-y-5">
      <PageIntro description="Control which apps and sites each child can reach." />

      <ChildTabs items={childList} selectedId={selected?.id} onSelect={setSelected} />

      {error && <p className="notice-error">{error}</p>}

      {/* Two long columns stacked on a phone means the website rules start four
          screens down. One at a time below `lg`, both side by side above it. */}
      <div className="flex gap-2 lg:hidden">
        {[{ key: 'apps', label: 'Apps' }, { key: 'websites', label: 'Websites' }].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setView(key)}
            aria-pressed={view === key}
            className={`chip flex-1 justify-center ${view === key ? 'chip-active' : ''}`}
          >
            {label}
          </button>
        ))}
      </div>

      {selected && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6 items-start">
          {/* ── Apps ──────────────────────────────────────────────────────── */}
          <div className={`space-y-4 ${view === 'apps' ? '' : 'hidden lg:block'}`}>
            <div className="card">
              <h2 className="section-title mb-3">Quick block</h2>
              <div className="grid grid-cols-2 gap-2">
                {POPULAR_APPS.map((app) => {
                  const blocked = appRules.some((r) => r.appPackage === app.package && r.action === 'block');
                  return (
                    <button
                      key={app.package}
                      onClick={() => !blocked && addApp(app)}
                      disabled={blocked}
                      className={`flex items-center gap-2 min-h-[48px] px-3 rounded-xl border text-sm font-medium transition ${
                        blocked
                          ? 'border-red-200 bg-red-50 text-red-600 cursor-default'
                          : 'border-gray-200 text-gray-700 hover:border-red-300 hover:bg-red-50'
                      }`}
                    >
                      <Icon name={blocked ? 'block' : 'plus'} size={16} className="shrink-0" />
                      <span className="truncate">{app.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="card">
              <h2 className="section-title mb-3">Custom app rule</h2>
              <div className="space-y-3">
                {knownApps.length > 0 && (
                  <label className="field">
                    <span className="field-label">App used on this device</span>
                    <select
                      className="input"
                      value={knownApps.some((a) => a.appPackage === appForm.appPackage) ? appForm.appPackage : ''}
                      onChange={(e) => chooseKnownApp(e.target.value)}
                    >
                      <option value="">Choose an app…</option>
                      {knownApps.map((a) => (
                        <option key={a.appPackage} value={a.appPackage}>{a.appName}</option>
                      ))}
                    </select>
                    <span className="field-hint">
                      Apps {selected?.name || 'this child'} has actually opened, most-used first.
                    </span>
                  </label>
                )}

                <label className="field">
                  <span className="field-label">App name</span>
                  <input
                    className="input" placeholder="e.g. Roblox" value={appForm.appName}
                    onChange={(e) => setAppForm({ ...appForm, appName: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Package name</span>
                  <input
                    className="input" placeholder="e.g. com.roblox.client"
                    value={appForm.appPackage}
                    onChange={(e) => setAppForm({ ...appForm, appPackage: e.target.value })}
                  />
                  {/* Said "Optional" and was not: the phone matches on the package
                      and nothing else, so a rule saved without one sat in this
                      list looking active and blocked nothing. */}
                  <span className="field-hint">
                    Required — it is what the phone matches. Pick the app above, or find it in the
                    Play Store address bar after <code>?id=</code>.
                  </span>
                </label>
                <label className="field">
                  <span className="field-label">Rule</span>
                  <select
                    className="input" value={appForm.action}
                    onChange={(e) => setAppForm({ ...appForm, action: e.target.value })}
                  >
                    {APP_ACTIONS.map(({ value, label }) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                {appForm.action === 'limit' && (
                  <label className="field">
                    <span className="field-label">Minutes per day</span>
                    <input
                      className="input" type="number" inputMode="numeric" min="5" max="1440" step="5"
                      value={appForm.dailyLimitMinutes}
                      onChange={(e) => setAppForm({ ...appForm, dailyLimitMinutes: e.target.value })}
                    />
                    <span className="field-hint">
                      The app is blocked for the rest of the day once this is reached, and released
                      at midnight.
                    </span>
                  </label>
                )}
                <button
                  onClick={() => addApp()}
                  className="btn-primary btn-block"
                  disabled={!appForm.appName.trim() || !appForm.appPackage.trim()}
                >
                  Add app rule
                </button>
              </div>
            </div>

            <div className="card">
              <h2 className="section-title mb-3">Active app rules</h2>
              {appRules.length === 0 ? (
                <EmptyState compact icon="block" title="No app rules yet" />
              ) : (
                <div className="space-y-2">
                  {appRules.map((r) =>
                    ruleRow(
                      r.id,
                      r.appName,
                      // A rule with no package predates the requirement and cannot
                      // be enforced, so it says so rather than looking active.
                      r.appPackage || 'No package name — not enforced',
                      r.action === 'limit' && r.dailyLimitMinutes
                        ? `${r.dailyLimitMinutes}m/day`
                        : r.action,
                      () => removeApp(r.id)
                    )
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── Websites ──────────────────────────────────────────────────── */}
          <div className={`space-y-4 ${view === 'websites' ? '' : 'hidden lg:block'}`}>
            <div className="card">
              <h2 className="section-title mb-3">Block categories</h2>
              <div className="flex flex-wrap gap-2">
                {WEBSITE_CATEGORIES.map(({ key, label, description }) => {
                  const blocked = webRules.some((r) => r.category === key && r.action === 'block');
                  return (
                    <button
                      key={key}
                      onClick={() => !blocked && addCategory(key)}
                      disabled={blocked}
                      title={description}
                      className={`chip ${
                        blocked ? 'bg-red-50 border-red-200 text-red-600 cursor-default' : ''
                      }`}
                    >
                      {blocked && <Icon name="block" size={14} />}
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="card">
              <h2 className="section-title mb-3">Block a specific site</h2>
              <form onSubmit={addWebsite} className="space-y-3">
                <label className="field">
                  <span className="field-label">Website</span>
                  <input
                    className="input" placeholder="e.g. example.com" inputMode="url"
                    value={webForm.url}
                    onChange={(e) => setWebForm({ ...webForm, url: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Rule</span>
                  <select
                    className="input" value={webForm.action}
                    onChange={(e) => setWebForm({ ...webForm, action: e.target.value })}
                  >
                    <option value="block">Block</option>
                    <option value="allow">Allow only (whitelist)</option>
                  </select>
                </label>
                <button type="submit" className="btn-primary btn-block" disabled={!webForm.url.trim()}>
                  Add website rule
                </button>
              </form>
            </div>

            <div className="card">
              <h2 className="section-title mb-3">Active website rules</h2>
              {webRules.length === 0 ? (
                <EmptyState compact icon="globe" title="No website rules yet" />
              ) : (
                <div className="space-y-2">
                  {webRules.map((r) =>
                    ruleRow(
                      r.id,
                      r.url || categoryLabel(r.category),
                      r.url ? 'Specific site' : 'Category',
                      r.action,
                      () => removeWebsite(r.id)
                    )
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
