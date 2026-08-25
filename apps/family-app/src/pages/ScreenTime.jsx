import { useEffect, useState } from 'react';
import {
  children as childrenApi, screenTime as screenTimeApi,
  errorMessage, EmptyState, Icon, Toggle,
} from '@parentix/shared';
import ChildTabs from '../components/ChildTabs';
import DeviceScopeTabs from '../components/DeviceScopeTabs';
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

/** The top-ups worth one tap. Anything else is a change to the limit itself. */
const GRANT_OPTIONS = [15, 30, 60];

/**
 * The granted minutes that are still in play, summed against *this browser's*
 * calendar day.
 *
 * The API deliberately answers with rows and timestamps rather than a total: it
 * runs in UTC and the families do not, so a total computed there would reset in
 * front of the parent at 20:00 local — the same rollover that made every
 * evening's screen time double-count until the day boundary moved to whoever
 * actually knows one. The parent's browser knows one, so it applies it here, and
 * the child's device applies its own when it spends them.
 */
const grantedTodayFrom = (grants) => {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return (grants || []).reduce((total, grant) => {
    const at = new Date(grant?.grantedAt ?? NaN);
    if (Number.isNaN(at.getTime()) || at < midnight) return total;
    return total + (Number(grant.minutes) || 0);
  }, 0);
};

export default function ScreenTime() {
  const [childList, setChildList] = useState([]);
  const [selected, setSelected] = useState(null);
  /**
   * Which devices the rule on screen applies to: `null` for all of this child's,
   * or one device id.
   *
   * `null` is the default and stays the default. A parent who never touches the
   * device tabs writes exactly the rule this page has always written.
   */
  const [scope, setScope] = useState(null);
  const [rule, setRule] = useState(null);
  // Device ids that already have their own rule, so the tabs can mark them.
  const [overridden, setOverridden] = useState([]);
  /** Extra minutes granted recently, as rows — see `grantedTodayFrom`. */
  const [grants, setGrants] = useState([]);
  const [granting, setGranting] = useState(false);
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

  // Changing child resets the scope: a device id from one child means nothing
  // under another, and the API would refuse it.
  useEffect(() => { setScope(null); }, [selected?.id]);

  useEffect(() => {
    if (!selected) return;
    setRule(null);
    screenTimeApi.get(selected.id, scope)
      .then((r) => setRule(r.data))
      .catch(() => setError('Could not load the screen time rules for this child.'));
  }, [selected, scope]);

  /**
   * Extra minutes already in play for the scope on screen.
   *
   * Advisory — a failure leaves the total unshown rather than raising a banner,
   * because the rules above are what this page is for and an empty grant list is
   * also the ordinary case. Reloaded after each grant so the running total is the
   * server's answer rather than an optimistic sum this page kept for itself.
   */
  useEffect(() => {
    if (!selected) { setGrants([]); return undefined; }
    let cancelled = false;
    screenTimeApi.grants(selected.id, scope)
      .then((r) => { if (!cancelled) setGrants(r.data?.grants || []); })
      .catch(() => { if (!cancelled) setGrants([]); });
    return () => { cancelled = true; };
  }, [selected, scope]);

  /**
   * Which of this child's devices already have an exception.
   *
   * Read by asking for each device's rule and seeing whether the answer carries
   * its device id — `GET` creates the row on first look, so this cannot be a
   * survey of what exists without also creating it. Instead it reads the rules
   * the *devices* would get, which is the honest question anyway, and only for
   * devices the parent can see.
   */
  useEffect(() => {
    const devices = (selected?.devices || []).filter((d) => d.isLinked);
    if (!selected || devices.length < 2) { setOverridden([]); return; }
    let cancelled = false;
    Promise.all(devices.map((d) => screenTimeApi.get(selected.id, d.id)
      .then((r) => (r.data?.deviceId === d.id ? d.id : null))
      .catch(() => null)))
      .then((ids) => { if (!cancelled) setOverridden(ids.filter(Boolean)); });
    return () => { cancelled = true; };
  }, [selected, saved]);

  const scopeDevice = (selected?.devices || []).find((d) => d.id === scope) || null;
  const grantedToday = grantedTodayFrom(grants);

  const save = async () => {
    setSaving(true);
    setError(''); setSaved('');
    try {
      await screenTimeApi.update(selected.id, rule, scope);
      setSaved(scope ? 'Rules saved for this device.' : 'Screen time rules saved.');
      setTimeout(() => setSaved(''), 3000);
    } catch (err) {
      setError(errorMessage(err, 'Could not save the screen time rules.'));
    } finally {
      setSaving(false);
    }
  };

  /**
   * Drop this device's exception so it follows the child's rule again.
   *
   * Not the same as typing the child's numbers back in by hand, which leaves an
   * exception that merely agrees today and stops tracking the child rule the
   * moment the parent edits it — the difference nobody would notice until a
   * limit change failed to reach one device.
   */
  const useChildRule = async () => {
    if (!scope) return;
    setSaving(true);
    setError(''); setSaved('');
    try {
      await screenTimeApi.clearDeviceRule(selected.id, scope);
      setScope(null);
      setSaved('That device follows the shared rules again.');
      setTimeout(() => setSaved(''), 3000);
    } catch (err) {
      setError(errorMessage(err, 'Could not remove that device rule.'));
    } finally {
      setSaving(false);
    }
  };

  /**
   * Give minutes back for today, without touching the rule.
   *
   * This is the answer to a request the product has been making for a while with
   * nothing on this side to receive it: both lock screens and the child app's
   * Messages offer "ask for more time", and until now saying yes meant raising
   * `dailyLimitMinutes` and remembering to lower it in the morning. Nobody
   * remembers, so limits crept upwards all term and children learned that asking
   * changes the rule permanently.
   *
   * Deliberately not a confirmation step. A parent tapping this is usually
   * standing next to the child who asked, and it expires by itself tonight — the
   * cost of a mis-tap is fifteen minutes, and the cost of a dialog is that the
   * feature is slower than editing the rule it exists to replace.
   */
  const grant = async (minutes) => {
    if (!selected) return;
    setGranting(true);
    setError(''); setSaved('');
    try {
      await screenTimeApi.grant(selected.id, minutes, scope);
      const r = await screenTimeApi.grants(selected.id, scope);
      setGrants(r.data?.grants || []);
      setSaved(scope
        ? `${formatLimit(minutes)} added on this device for today.`
        : `${formatLimit(minutes)} added for today.`);
      setTimeout(() => setSaved(''), 3000);
    } catch (err) {
      setError(errorMessage(err, 'Could not add extra time.'));
    } finally {
      setGranting(false);
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

      <DeviceScopeTabs
        devices={selected?.devices || []}
        selectedId={scope}
        onSelect={setScope}
        overriddenIds={overridden}
      />

      {!rule ? (
        <p className="text-sm text-gray-400 py-8">Loading rules…</p>
      ) : (
        <div className="space-y-4 max-w-2xl">
          {/* Which rule is being edited, said in words rather than left to the
              selected tab. A parent who set a limit on the wrong device would
              otherwise only find out from the child. */}
          {scope && (
            <div className="card bg-amber-50 border-amber-200 flex items-start gap-3">
              <span className="text-warning mt-0.5 shrink-0"><Icon name="lock" size={17} /></span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900">
                  Just for {scopeDevice?.name || 'this device'}
                </p>
                <p className="text-xs text-gray-600 mt-0.5">
                  {selected?.name}
                  ’s other devices keep the shared rules.
                </p>
              </div>
              <button
                type="button"
                onClick={useChildRule}
                disabled={saving}
                className="btn-secondary btn-sm shrink-0 disabled:opacity-50"
              >
                Use shared rules
              </button>
            </div>
          )}

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
              /* h-11 rather than h-6: the track is drawn the same, but the
                 element itself is a 44px grab area. At 24px this was the
                 hardest control in the app to catch with a thumb, and it is the
                 one a parent adjusts most. */
              className="w-full h-11 cursor-pointer"
              aria-label={`Daily limit for ${selected?.name}`}
            />
            <div className="flex justify-between text-xs text-gray-400 mt-1">
              <span>15m</span>
              <span>8h</span>
            </div>
          </div>

          {/* Separate from the slider on purpose. The slider is the policy —
              what this child gets every day — and this is a one-off answer to a
              question they asked tonight. Folding the two together is exactly the
              habit that leaves a Tuesday's extra half-hour still in force in
              November. */}
          <div className="card">
            <div className="flex items-baseline justify-between gap-3 mb-1">
              <h2 className="section-title">Extra time today</h2>
              {grantedToday > 0 && (
                <span className="text-sm font-semibold text-primary-600 tabular-nums">
                  +{formatLimit(grantedToday)}
                </span>
              )}
            </div>
            <p className="text-sm text-gray-500 mb-3">
              {grantedToday > 0
                ? `${selected?.name || 'This child'} has ${formatLimit(grantedToday)} on top of the daily limit. It expires tonight.`
                : 'Add minutes for today only. The daily limit above is unchanged, and the extra time expires at midnight.'}
            </p>
            <div className="flex flex-wrap gap-2">
              {GRANT_OPTIONS.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  onClick={() => grant(minutes)}
                  disabled={granting}
                  /* min-h-[44px]: this is the control a parent reaches for while
                     a child is asking them for it, usually one-handed. */
                  className="btn-secondary min-h-[44px] px-5 disabled:opacity-50"
                >
                  +{formatLimit(minutes)}
                </button>
              ))}
            </div>
            {scope && (
              <p className="text-xs text-gray-500 mt-3">
                Only {scopeDevice?.name || 'this device'} gets these minutes.
              </p>
            )}
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
