import { useEffect, useState } from 'react';
import {
  children as childrenApi, screenTime as screenTimeApi,
  errorMessage, EmptyState, Toggle,
} from '@parentix/shared';
import ChildTabs from '../components/ChildTabs';
import PageIntro from '../components/PageIntro';

const DAYS = [
  { key: 'monday', label: 'Monday', short: 'Mon' },
  { key: 'tuesday', label: 'Tuesday', short: 'Tue' },
  { key: 'wednesday', label: 'Wednesday', short: 'Wed' },
  { key: 'thursday', label: 'Thursday', short: 'Thu' },
  { key: 'friday', label: 'Friday', short: 'Fri' },
  { key: 'saturday', label: 'Saturday', short: 'Sat' },
  { key: 'sunday', label: 'Sunday', short: 'Sun' },
];

const formatLimit = (minutes) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
};

export default function ScreenTime() {
  const [childList, setChildList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [rule, setRule] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    childrenApi.list()
      .then((r) => { setChildList(r.data); if (r.data[0]) setSelected(r.data[0]); })
      .catch(() => setError('Could not load your children.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setRule(null);
    screenTimeApi.get(selected.id)
      .then((r) => setRule(r.data))
      .catch(() => setError('Could not load the screen time rules for this child.'));
  }, [selected]);

  const save = async () => {
    setSaving(true);
    setError(''); setSaved('');
    try {
      await screenTimeApi.update(selected.id, rule);
      setSaved('Screen time rules saved.');
      setTimeout(() => setSaved(''), 3000);
    } catch (err) {
      setError(errorMessage(err, 'Could not save the screen time rules.'));
    } finally {
      setSaving(false);
    }
  };

  const updateDay = (day, field, value) => {
    setRule((r) => ({
      ...r,
      schedule: { ...r.schedule, [day]: { ...r.schedule?.[day], [field]: value } },
    }));
  };

  if (loading) return <p className="text-sm text-gray-400 py-8">Loading…</p>;

  if (childList.length === 0) {
    return (
      <div className="card">
        <EmptyState
          icon="children"
          title="No child profiles yet"
          description="Add a child under Children before setting daily limits."
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageIntro description="Daily limits, bedtime and the hours devices may be used." />

      <ChildTabs items={childList} selectedId={selected?.id} onSelect={setSelected} />

      {!rule ? (
        <p className="text-sm text-gray-400 py-8">Loading rules…</p>
      ) : (
        <div className="space-y-4 max-w-2xl">
          <div className="card">
            <div className="flex items-baseline justify-between gap-3 mb-4">
              <h2 className="section-title">Daily limit</h2>
              <span className="text-xl font-bold text-primary-600 tabular-nums">
                {formatLimit(rule.dailyLimitMinutes)}
              </span>
            </div>
            <input
              type="range"
              min={15}
              max={480}
              step={15}
              value={rule.dailyLimitMinutes}
              onChange={(e) => setRule({ ...rule, dailyLimitMinutes: parseInt(e.target.value, 10) })}
              className="w-full h-6 cursor-pointer"
              aria-label={`Daily limit for ${selected?.name}`}
            />
            <div className="flex justify-between text-xs text-gray-400 mt-1">
              <span>15m</span>
              <span>8h</span>
            </div>
          </div>

          <div className="card">
            <Toggle
              label="Bedtime lock"
              description="Lock the device overnight between these times"
              checked={!!rule.bedtimeEnabled}
              onChange={(v) => setRule({ ...rule, bedtimeEnabled: v })}
            />
            {rule.bedtimeEnabled && (
              <div className="grid grid-cols-2 gap-3 mt-3 pt-4 border-t border-gray-50">
                <label className="field">
                  <span className="field-label text-xs">Locks at</span>
                  <input
                    type="time" className="input" value={rule.bedtimeStart || '21:00'}
                    onChange={(e) => setRule({ ...rule, bedtimeStart: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="field-label text-xs">Unlocks at</span>
                  <input
                    type="time" className="input" value={rule.bedtimeEnd || '07:00'}
                    onChange={(e) => setRule({ ...rule, bedtimeEnd: e.target.value })}
                  />
                </label>
              </div>
            )}
          </div>

          <div className="card">
            <h2 className="section-title mb-1">Allowed hours</h2>
            <p className="text-sm text-gray-500 mb-3">
              Turn a day on to restrict device use to a window of that day.
            </p>

            {/* One day per block, times on their own row. Three controls and a
                label side by side needed ~420px and overflowed every phone. */}
            <div className="divide-y divide-gray-50">
              {DAYS.map(({ key, label }) => {
                const day = rule.schedule?.[key] || {};
                return (
                  <div key={key} className="py-1">
                    <Toggle
                      label={label}
                      checked={!!day.enabled}
                      size="sm"
                      onChange={(v) => updateDay(key, 'enabled', v)}
                    />
                    {day.enabled && (
                      <div className="grid grid-cols-2 gap-3 pb-3">
                        <label className="field">
                          <span className="field-label text-xs">From</span>
                          <input
                            type="time" className="input" value={day.start || '08:00'}
                            onChange={(e) => updateDay(key, 'start', e.target.value)}
                          />
                        </label>
                        <label className="field">
                          <span className="field-label text-xs">Until</span>
                          <input
                            type="time" className="input" value={day.end || '20:00'}
                            onChange={(e) => updateDay(key, 'end', e.target.value)}
                          />
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {error && <p className="notice-error">{error}</p>}
          {saved && <p className="notice-success">{saved}</p>}

          <button onClick={save} disabled={saving} className="btn-primary btn-block sm:w-auto">
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}
    </div>
  );
}
