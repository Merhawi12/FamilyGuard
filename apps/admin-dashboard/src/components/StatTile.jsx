import { Icon } from '@parentix/shared';

/**
 * One headline number, the console's way.
 *
 * Not the shared `StatsCard` the family app uses: this one carries a label above
 * an icon chip, a unit beside the value rather than under it, an optional
 * movement chip, and an optional visual under the number (a sparkline, a row of
 * bars, a meter). Two console screens draw these, which is why it is a component
 * and not a shape each page reinvents — three tiles in a row have to be exactly
 * the same height whatever they happen to contain.
 *
 * `alert` tints the whole tile red. It is for a number that is bad news when it
 * is not zero (devices offline, accounts blocked), not for a number that is
 * merely large.
 *
 * `delta` is a signed percentage. `up` is not automatically good — the caller
 * says which direction is healthy with `goodWhenUp`, because "signups up 4%" and
 * "offline devices up 4%" want opposite colours. A delta of exactly zero is
 * neither: it draws grey and says so, rather than colouring a number that did
 * not move as though it had moved the right way.
 */
export default function StatTile({
  label,
  value,
  unit,
  icon,
  delta = null,
  deltaLabel,
  goodWhenUp = true,
  alert = false,
  children,
}) {
  const flat = delta === 0;
  const rising = delta !== null && delta > 0;
  const healthy = rising === goodWhenUp;

  return (
    <div className={`card p-4 sm:p-5 h-full flex flex-col ${alert ? 'bg-red-50 border-red-100' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        {/* One line, always: a wrapped label makes three tiles three heights. */}
        <p className={`text-[10px] font-semibold uppercase tracking-[0.1em] whitespace-nowrap truncate ${
          alert ? 'text-red-700' : 'text-gray-500'
        }`}>
          {label}
        </p>
        <span className={`inline-flex items-center justify-center w-9 h-9 rounded-xl shrink-0 ${
          alert ? 'bg-red-100 text-red-600' : 'bg-primary-50 text-primary-600'
        }`}>
          <Icon name={icon} size={18} />
        </span>
      </div>

      <p className="mt-2 sm:mt-4 flex items-baseline flex-wrap gap-x-1.5 gap-y-1 min-w-0">
        <span className={`text-2xl sm:text-3xl font-bold tracking-tight ${
          alert ? 'text-red-700' : 'text-gray-900'
        }`}>
          {value}
        </span>
        {unit && <span className="text-xs text-gray-500 truncate">{unit}</span>}
        {delta !== null && (
          <span
            title={deltaLabel}
            className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[11px] font-semibold ${
              flat ? 'bg-gray-100 text-gray-500'
                : healthy ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'
            }`}
          >
            {flat ? (
              <>
                <Icon name="minus" size={11} strokeWidth={2.6} />
                No change
              </>
            ) : (
              <>
                <Icon
                  name="chevronDown"
                  size={11}
                  strokeWidth={2.6}
                  className={rising ? 'rotate-180' : ''}
                />
                {Math.abs(delta)}%
              </>
            )}
          </span>
        )}
      </p>

      {/* Pushed to the foot so a tile with a chart and one without still line up. */}
      {children && <div className="mt-auto pt-3">{children}</div>}
    </div>
  );
}
