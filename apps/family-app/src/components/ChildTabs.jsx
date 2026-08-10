import { Avatar } from '@parentix/shared';

/**
 * "Which child am I looking at" — the control eight screens need.
 *
 * Each of them had its own copy, with its own padding, its own active colour
 * and a `flex-wrap` that turned into three stacked rows of pills on a phone as
 * soon as a family had four children. One horizontal scroller instead, with the
 * chips at a size a thumb can hit.
 *
 * Hidden for a family with a single child: a one-option picker is decoration.
 */
export default function ChildTabs({ items = [], selectedId, onSelect, className = '' }) {
  if (items.length < 2) return null;

  return (
    <div className={`-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto no-scrollbar scroll-touch ${className}`}>
      <div className="flex gap-2 w-max pb-0.5" role="tablist" aria-label="Children">
        {items.map((child) => {
          const active = selectedId === child.id;
          return (
            <button
              key={child.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onSelect(child)}
              className={`chip pl-1.5 pr-4 ${active ? 'chip-active' : ''}`}
            >
              <Avatar
                name={child.name}
                imageUrl={child.avatarUrl}
                size="xs"
                className={active ? 'ring-2 ring-white/40' : ''}
              />
              {child.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
