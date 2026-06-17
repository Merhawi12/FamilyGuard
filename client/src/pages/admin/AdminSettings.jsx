import { useEffect, useState } from 'react';
import { admin as adminApi } from '../../services/api';

const PLANS = ['free', 'premium', 'family'];

export default function AdminSettings() {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    adminApi.getSettings().then((r) => setSettings(r.data)).catch((e) => setError(e.response?.data?.error || 'Failed to load settings'));
  }, []);

  const toggleFeature = (plan, feature) => {
    setSettings((s) => {
      const current = s.planFeatures[plan] || [];
      const updated = current.includes(feature) ? current.filter((f) => f !== feature) : [...current, feature];
      return { ...s, planFeatures: { ...s.planFeatures, [plan]: updated } };
    });
  };

  const handleSave = async () => {
    setSaving(true); setError(''); setSaved('');
    try {
      await adminApi.updateSettings({
        maintenanceMode: settings.maintenanceMode,
        defaultTrialDays: settings.defaultTrialDays,
        planFeatures: settings.planFeatures,
      });
      setSaved('Settings saved');
      setTimeout(() => setSaved(''), 2500);
    } catch (e) { setError(e.response?.data?.error || 'Failed to save settings'); }
    finally { setSaving(false); }
  };

  if (error && !settings) return <div className="p-3 bg-red-50 text-red-700 rounded-xl text-sm">{error}</div>;
  if (!settings) return <div className="text-gray-400">Loading settings...</div>;

  const featureKeys = Object.keys(settings.featureLabels);

  return (
    <div className="space-y-6 max-w-2xl">
      {error && <div className="p-3 bg-red-50 text-red-700 rounded-xl text-sm">{error}</div>}
      {saved && <div className="p-3 bg-green-50 text-green-700 rounded-xl text-sm">{saved}</div>}

      <div className="card">
        <h2 className="font-semibold mb-4">General</h2>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Maintenance Mode</p>
              <p className="text-xs text-gray-400">Show a maintenance banner / block new logins</p>
            </div>
            <button
              onClick={() => setSettings({ ...settings, maintenanceMode: !settings.maintenanceMode })}
              className={`w-11 h-6 rounded-full transition-colors ${settings.maintenanceMode ? 'bg-blue-600' : 'bg-gray-200'}`}
            >
              <span className={`block w-4 h-4 bg-white rounded-full shadow transition-transform mx-1 ${settings.maintenanceMode ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>

          <label className="block">
            <span className="text-sm text-gray-500">Default trial length (days)</span>
            <input
              type="number"
              min="1"
              className="input mt-1"
              value={settings.defaultTrialDays}
              onChange={(e) => setSettings({ ...settings, defaultTrialDays: parseInt(e.target.value) || 1 })}
            />
          </label>
        </div>
      </div>

      <div className="card">
        <h2 className="font-semibold mb-1">Plan Features</h2>
        <p className="text-sm text-gray-500 mb-4">Control which features each subscription plan unlocks.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 text-xs uppercase">
                <th className="py-2">Feature</th>
                {PLANS.map((p) => <th key={p} className="py-2 capitalize text-center">{p}</th>)}
              </tr>
            </thead>
            <tbody>
              {featureKeys.map((key) => (
                <tr key={key} className="border-t border-gray-100">
                  <td className="py-3">{settings.featureLabels[key]}</td>
                  {PLANS.map((plan) => (
                    <td key={plan} className="py-3 text-center">
                      <input
                        type="checkbox"
                        checked={(settings.planFeatures[plan] || []).includes(key)}
                        onChange={() => toggleFeature(plan, key)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <button onClick={handleSave} disabled={saving} className="btn-primary disabled:opacity-60">
        {saving ? 'Saving...' : 'Save Settings'}
      </button>
    </div>
  );
}
