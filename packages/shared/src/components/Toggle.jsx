/**
 * An on/off switch.
 *
 * Every settings screen had been hand-rolling this out of a `<button>` and two
 * `<span>`s, which meant five copies with five slightly different sizes and no
 * accessible state at all — a screen reader announced them as plain buttons, so
 * there was no way to tell an "on" switch from an "off" one.
 *
 * Given a `label`, the whole row is the target rather than the 44×24 switch
 * alone; that is the difference between "tap the tiny switch" and "tap the
 * setting", and it costs nothing.
 *
 * `layout="inline"` is the same switch as a pill beside a heading — the console's
 * Live Tail control — rather than a full-width settings row. The label still
 * comes with it, so the target is the whole pill either way.
 */
export default function Toggle({
  checked = false,
  onChange,
  label,
  description,
  disabled = false,
  size = 'md',
  layout = 'row',
  className = '',
  'aria-label': ariaLabel,
}) {
  const sm = size === 'sm';

  const track = (
    <span
      className={`relative inline-flex items-center shrink-0 rounded-full transition-colors
        ${sm ? 'w-9 h-5' : 'w-11 h-6'}
        ${checked ? 'bg-primary-600' : 'bg-gray-200'}
        ${disabled ? 'opacity-40' : ''}`}
    >
      <span
        className={`absolute bg-white rounded-full shadow transition-transform
          ${sm ? 'w-3.5 h-3.5 left-[3px]' : 'w-4 h-4 left-1'}
          ${checked ? (sm ? 'translate-x-4' : 'translate-x-5') : 'translate-x-0'}`}
      />
    </span>
  );

  // Bare switch — the caller is placing it inside a row of their own.
  if (!label) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => onChange?.(!checked)}
        className={`inline-flex items-center justify-center w-11 h-11 -m-2.5 rounded-full
                    disabled:cursor-not-allowed ${className}`}
      >
        {track}
      </button>
    );
  }

  // A pill: the switch first, then what it switches — a control on a toolbar
  // rather than a row in a list of settings.
  if (layout === 'inline') {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange?.(!checked)}
        className={`inline-flex items-center gap-2.5 min-h-[36px] px-3 rounded-lg border transition
                    text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50
                    ${checked
    ? 'bg-primary-50 border-primary-200 text-primary-800'
    : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'} ${className}`}
      >
        {track}
        <span className="whitespace-nowrap">{label}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={`w-full flex items-center gap-4 text-left min-h-[56px] py-2 rounded-xl transition
                  disabled:cursor-not-allowed ${className}`}
    >
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-gray-900">{label}</span>
        {description && <span className="block text-xs text-gray-500 mt-0.5">{description}</span>}
      </span>
      {track}
    </button>
  );
}
