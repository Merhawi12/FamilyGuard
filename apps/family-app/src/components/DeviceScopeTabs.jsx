import { Icon } from '@parentix/shared';

const DEVICE_ICON = { android: 'phone', ios: 'phone', windows: 'laptop', mac: 'laptop' };

/**
 * "Which of this child's devices am I setting a rule for?"
 *
 * Sits under ChildTabs on every screen that writes a rule, and follows the same
 * rule as that control: hidden when a child has fewer than two devices, because
 * a picker with one real option is decoration and the answer cannot be anything
 * else.
 *
 * "All devices" is first and selected by default, and that ordering is doing
 * real work. Per-device rules are the exception, not the norm — a parent who
 * has never thought about it should set one limit for their child and have it
 * apply everywhere, exactly as this page behaved before the option existed. A
 * device tab is something you go and choose.
 *
 * A tab whose device has an exception is marked, so a parent can see at a glance
 * that the laptop is not simply following the child's rule. Without it the only
 * way to find an override is to click every tab, and a forgotten exception on a
 * device is precisely the thing that makes a parental control look broken: the
 * limit says one hour, the child plays for three, and nothing on the screen the
 * parent is looking at explains it.
 */
export default function DeviceScopeTabs({
  devices = [], selectedId = null, onSelect, overriddenIds = [], className = '',
}) {
  const linked = devices.filter((d) => d.isLinked);
  if (linked.length < 2) return null;

  const tab = (id, label, icon, marked) => {
    const active = selectedId === id;
    return (
      <button
        key={id ?? 'all'}
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => onSelect(id)}
        className={`chip px-4 ${active ? 'chip-active' : ''}`}
      >
        <Icon name={icon} size={15} />
        {label}
        {marked && (
          <span
            className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-white/70' : 'bg-warning'}`}
            /* Not colour alone: a dot with no name is invisible to a screen
               reader and ambiguous to anyone who cannot tell it from the chip. */
            aria-label="has its own rule"
          />
        )}
      </button>
    );
  };

  return (
    <div className={`-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto no-scrollbar scroll-touch ${className}`}>
      <div className="flex gap-2 w-max pb-0.5" role="tablist" aria-label="Devices">
        {tab(null, 'All devices', 'shield', false)}
        {linked.map((d) => tab(
          d.id,
          d.name,
          DEVICE_ICON[d.type] || 'phone',
          overriddenIds.includes(d.id),
        ))}
      </div>
    </div>
  );
}
