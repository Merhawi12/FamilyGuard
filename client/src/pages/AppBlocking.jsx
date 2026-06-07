import { useEffect, useState } from 'react';
import { children as childrenApi, blocking as blockingApi } from '../services/api';

const POPULAR_APPS = [
  { name: 'TikTok', package: 'com.zhiliaoapp.musically', icon: '🎵' },
  { name: 'Instagram', package: 'com.instagram.android', icon: '📸' },
  { name: 'YouTube', package: 'com.google.android.youtube', icon: '▶️' },
  { name: 'Snapchat', package: 'com.snapchat.android', icon: '👻' },
  { name: 'WhatsApp', package: 'com.whatsapp', icon: '💬' },
  { name: 'PUBG Mobile', package: 'com.tencent.ig', icon: '🎮' },
];

const WEBSITE_CATEGORIES = ['adult', 'gambling', 'gaming', 'social_media', 'violence'];

export default function AppBlocking() {
  const [childList, setChildList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [appRules, setAppRules] = useState([]);
  const [webRules, setWebRules] = useState([]);
  const [appForm, setAppForm] = useState({ appName: '', appPackage: '', action: 'block' });
  const [webForm, setWebForm] = useState({ url: '', category: 'custom', action: 'block' });

  useEffect(() => { childrenApi.list().then((r) => { setChildList(r.data); if (r.data[0]) setSelected(r.data[0]); }); }, []);

  useEffect(() => {
    if (!selected) return;
    blockingApi.getApps(selected.id).then((r) => setAppRules(r.data));
    blockingApi.getWebsites(selected.id).then((r) => setWebRules(r.data));
  }, [selected]);

  const addApp = async (app) => {
    const data = typeof app === 'object' ? { appName: app.name, appPackage: app.package, action: 'block' } : appForm;
    const r = await blockingApi.addApp(selected.id, data);
    setAppRules((prev) => [...prev, r.data]);
    setAppForm({ appName: '', appPackage: '', action: 'block' });
  };

  const removeApp = async (ruleId) => {
    await blockingApi.removeApp(selected.id, ruleId);
    setAppRules((prev) => prev.filter((r) => r.id !== ruleId));
  };

  const addWebsite = async (e) => {
    e.preventDefault();
    const r = await blockingApi.addWebsite(selected.id, webForm);
    setWebRules((prev) => [...prev, r.data]);
    setWebForm({ url: '', category: 'custom', action: 'block' });
  };

  const removeWebsite = async (ruleId) => {
    await blockingApi.removeWebsite(selected.id, ruleId);
    setWebRules((prev) => prev.filter((r) => r.id !== ruleId));
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">App & Website Blocking</h1>
        <p className="text-gray-500 text-sm mt-1">Control which apps and sites are accessible</p>
      </div>

      <div className="flex gap-2 flex-wrap">
        {childList.map((c) => (
          <button key={c.id} onClick={() => setSelected(c)}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition ${selected?.id === c.id ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'}`}>
            {c.name}
          </button>
        ))}
      </div>

      {selected && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div className="card">
              <h2 className="font-semibold mb-3">Quick Block — Popular Apps</h2>
              <div className="grid grid-cols-2 gap-2">
                {POPULAR_APPS.map((app) => {
                  const blocked = appRules.some((r) => r.appPackage === app.package && r.action === 'block');
                  return (
                    <button key={app.package}
                      onClick={() => blocked ? null : addApp(app)}
                      className={`flex items-center gap-2 p-2 rounded-xl border text-sm transition ${blocked ? 'border-red-200 bg-red-50 text-red-600 cursor-default' : 'border-gray-200 hover:border-red-300 hover:bg-red-50'}`}>
                      <span>{app.icon}</span>
                      <span className="font-medium">{app.name}</span>
                      {blocked && <span className="ml-auto text-xs badge-red">Blocked</span>}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="card">
              <h2 className="font-semibold mb-3">Custom App Rule</h2>
              <div className="space-y-2">
                <input className="input" placeholder="App name" value={appForm.appName} onChange={(e) => setAppForm({ ...appForm, appName: e.target.value })} />
                <input className="input" placeholder="Package name (optional)" value={appForm.appPackage} onChange={(e) => setAppForm({ ...appForm, appPackage: e.target.value })} />
                <select className="input" value={appForm.action} onChange={(e) => setAppForm({ ...appForm, action: e.target.value })}>
                  <option value="block">Block</option>
                  <option value="allow">Allow only</option>
                  <option value="limit">Limit time</option>
                </select>
                <button onClick={() => addApp()} className="btn-danger w-full" disabled={!appForm.appName}>Add Rule</button>
              </div>
            </div>

            <div className="card">
              <h2 className="font-semibold mb-3">Active App Rules</h2>
              {appRules.length === 0 ? <p className="text-gray-400 text-sm">No app rules set</p> : (
                <div className="space-y-2">
                  {appRules.map((r) => (
                    <div key={r.id} className="flex items-center justify-between p-2 bg-gray-50 rounded-xl">
                      <div>
                        <p className="text-sm font-medium">{r.appName}</p>
                        <p className="text-xs text-gray-400">{r.appPackage || 'No package'}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={r.action === 'block' ? 'badge-red' : 'badge-green'}>{r.action}</span>
                        <button onClick={() => removeApp(r.id)} className="text-red-400 hover:text-red-600 text-xs">Remove</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className="card">
              <h2 className="font-semibold mb-3">Block Website Categories</h2>
              <div className="flex flex-wrap gap-2">
                {WEBSITE_CATEGORIES.map((cat) => {
                  const blocked = webRules.some((r) => r.category === cat && r.action === 'block');
                  return (
                    <button key={cat}
                      onClick={() => !blocked && blockingApi.addWebsite(selected.id, { category: cat, action: 'block' }).then((r) => setWebRules((p) => [...p, r.data]))}
                      className={`px-3 py-1.5 rounded-lg text-sm capitalize transition ${blocked ? 'bg-red-100 text-red-600 border border-red-200' : 'bg-gray-100 hover:bg-red-100 hover:text-red-600'}`}>
                      {blocked ? '🚫 ' : ''}{cat.replace('_', ' ')}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="card">
              <h2 className="font-semibold mb-3">Block Specific Website</h2>
              <form onSubmit={addWebsite} className="space-y-2">
                <input className="input" placeholder="e.g. example.com" value={webForm.url} onChange={(e) => setWebForm({ ...webForm, url: e.target.value })} />
                <select className="input" value={webForm.action} onChange={(e) => setWebForm({ ...webForm, action: e.target.value })}>
                  <option value="block">Block</option>
                  <option value="allow">Allow (whitelist)</option>
                </select>
                <button type="submit" className="btn-danger w-full" disabled={!webForm.url}>Add Website Rule</button>
              </form>
            </div>

            <div className="card">
              <h2 className="font-semibold mb-3">Active Website Rules</h2>
              {webRules.length === 0 ? <p className="text-gray-400 text-sm">No website rules set</p> : (
                <div className="space-y-2">
                  {webRules.map((r) => (
                    <div key={r.id} className="flex items-center justify-between p-2 bg-gray-50 rounded-xl">
                      <div>
                        <p className="text-sm font-medium">{r.url || r.category}</p>
                        <p className="text-xs text-gray-400">{r.url ? 'Custom URL' : 'Category'}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={r.action === 'block' ? 'badge-red' : 'badge-green'}>{r.action}</span>
                        <button onClick={() => removeWebsite(r.id)} className="text-red-400 hover:text-red-600 text-xs">Remove</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
