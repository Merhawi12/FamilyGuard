import { useEffect, useState } from 'react';
import { children as childrenApi, screenTime as screenTimeApi } from '../services/api';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export default function ScreenTime() {
  const [childList, setChildList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [rule, setRule] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { childrenApi.list().then((r) => { setChildList(r.data); if (r.data[0]) setSelected(r.data[0]); }); }, []);
  useEffect(() => { if (selected) screenTimeApi.get(selected.id).then((r) => setRule(r.data)); }, [selected]);

  const save = async () => {
    setSaving(true);
    await screenTimeApi.update(selected.id, rule);
    setSaving(false);
  };

  const updateScheduleDay = (day, field, value) => {
    setRule((r) => ({ ...r, schedule: { ...r.schedule, [day]: { ...r.schedule[day], [field]: value } } }));
  };

  if (!rule) return <div className="text-gray-400">Select a child to configure screen time.</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Screen Time</h1>
        <p className="text-gray-500 text-sm mt-1">Set daily limits and schedules</p>
      </div>

      <div className="flex gap-2 flex-wrap">
        {childList.map((c) => (
          <button
            key={c.id}
            onClick={() => setSelected(c)}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition ${selected?.id === c.id ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'}`}
          >
            {c.name}
          </button>
        ))}
      </div>

      {selected && (
        <div className="space-y-4">
          <div className="card">
            <h2 className="font-semibold mb-4">Daily Limit for {selected.name}</h2>
            <div className="flex items-center gap-4">
              <input
                type="range" min={15} max={480} step={15}
                value={rule.dailyLimitMinutes}
                onChange={(e) => setRule({ ...rule, dailyLimitMinutes: parseInt(e.target.value) })}
                className="flex-1"
              />
              <span className="text-lg font-bold w-20 text-right">
                {Math.floor(rule.dailyLimitMinutes / 60)}h {rule.dailyLimitMinutes % 60}m
              </span>
            </div>
          </div>

          <div className="card">
            <h2 className="font-semibold mb-4">Bedtime Lock</h2>
            <div className="flex items-center gap-4 mb-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={rule.bedtimeEnabled} onChange={(e) => setRule({ ...rule, bedtimeEnabled: e.target.checked })} className="w-4 h-4" />
                <span className="text-sm">Enable bedtime lock</span>
              </label>
            </div>
            {rule.bedtimeEnabled && (
              <div className="flex gap-4">
                <label className="flex-1">
                  <span className="text-xs text-gray-500">Start (lock at)</span>
                  <input type="time" className="input mt-1" value={rule.bedtimeStart} onChange={(e) => setRule({ ...rule, bedtimeStart: e.target.value })} />
                </label>
                <label className="flex-1">
                  <span className="text-xs text-gray-500">End (unlock at)</span>
                  <input type="time" className="input mt-1" value={rule.bedtimeEnd} onChange={(e) => setRule({ ...rule, bedtimeEnd: e.target.value })} />
                </label>
              </div>
            )}
          </div>

          <div className="card">
            <h2 className="font-semibold mb-4">Daily Schedule</h2>
            <div className="space-y-3">
              {DAYS.map((day) => (
                <div key={day} className="flex items-center gap-4">
                  <input type="checkbox" checked={rule.schedule[day]?.enabled} onChange={(e) => updateScheduleDay(day, 'enabled', e.target.checked)} />
                  <span className="w-24 capitalize text-sm font-medium">{day}</span>
                  <input type="time" value={rule.schedule[day]?.start || '08:00'} onChange={(e) => updateScheduleDay(day, 'start', e.target.value)} className="input max-w-[130px]" disabled={!rule.schedule[day]?.enabled} />
                  <span className="text-gray-400 text-sm">to</span>
                  <input type="time" value={rule.schedule[day]?.end || '20:00'} onChange={(e) => updateScheduleDay(day, 'end', e.target.value)} className="input max-w-[130px]" disabled={!rule.schedule[day]?.enabled} />
                </div>
              ))}
            </div>
          </div>

          <button onClick={save} disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Save Changes'}</button>
        </div>
      )}
    </div>
  );
}
