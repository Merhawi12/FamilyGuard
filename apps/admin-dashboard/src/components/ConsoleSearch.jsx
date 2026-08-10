import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, useAuth } from '@parentix/shared';
import { visibleTo } from '../navigation';

/**
 * Jump to a screen by name.
 *
 * The console has nine screens behind a rail that can be folded or collapsed,
 * so the fastest route to one is typing its name. It searches the same list the
 * rail draws, which means it can only ever offer a screen the account is
 * actually allowed to open.
 *
 *   variant="bar"    header field, results in a popover  (⌘K / Ctrl-K)
 *   variant="sheet"  inside the phone dialog, results always listed
 */
export default function ConsoleSearch({
  variant = 'bar', className = '', id = 'console-search', onDone,
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const screens = useMemo(() => visibleTo(user), [user]);

  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef(null);

  const needle = query.trim().toLowerCase();
  const results = needle ? screens.filter((s) => s.label.toLowerCase().includes(needle)) : screens;
  const sheet = variant === 'sheet';
  const showing = sheet || focused;

  useEffect(() => { setCursor(0); }, [needle]);

  // A click anywhere else dismisses the popover; the sheet has its own backdrop.
  useEffect(() => {
    if (sheet || !focused) return undefined;
    const onPointerDown = (e) => { if (!rootRef.current?.contains(e.target)) setFocused(false); };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [sheet, focused]);

  const go = (item) => {
    if (!item) return;
    setQuery('');
    setFocused(false);
    navigate(item.to);
    onDone?.();
  };

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!results.length) return;
      event.preventDefault();
      setFocused(true);
      setCursor((i) => (event.key === 'ArrowDown'
        ? (i + 1) % results.length
        : (i - 1 + results.length) % results.length));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      go(results[cursor]);
      return;
    }
    if (event.key === 'Escape') {
      if (query) { setQuery(''); return; }
      setFocused(false);
      event.currentTarget.blur();
      onDone?.();
    }
  };

  const list = (
    <ul id={`${id}-results`} role="listbox" aria-label="Screens" className="p-1.5">
      {results.map((item, i) => (
        <li key={item.to}>
          <button
            type="button"
            id={`${id}-option-${i}`}
            role="option"
            aria-selected={i === cursor}
            // The input keeps the caret; blurring it before the click lands
            // would close the popover out from under the pointer.
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setCursor(i)}
            onClick={() => go(item)}
            className={`flex w-full items-center gap-3 min-h-[44px] px-2.5 rounded-xl text-sm text-left
                        transition-colors ${i === cursor ? 'bg-primary-50 text-primary-700' : 'text-gray-700'}`}
          >
            <span className={`flex items-center justify-center w-8 h-8 rounded-lg shrink-0
                              ${i === cursor ? 'bg-primary-100 text-primary-700' : 'bg-gray-100 text-gray-500'}`}>
              <Icon name={item.icon} size={17} />
            </span>
            <span className="flex-1 truncate font-medium">{item.label}</span>
            <Icon name="arrowRight" size={15} className="text-gray-300 shrink-0" />
          </button>
        </li>
      ))}
      {!results.length && (
        <li className="px-3 py-6 text-center text-sm text-gray-400">No screen matches “{query.trim()}”.</li>
      )}
    </ul>
  );

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400">
        <Icon name="search" size={17} />
      </span>
      <input
        id={id}
        type="search"
        role="combobox"
        aria-expanded={showing}
        aria-controls={`${id}-results`}
        aria-autocomplete="list"
        aria-activedescendant={showing && results[cursor] ? `${id}-option-${cursor}` : undefined}
        aria-label="Search the console"
        placeholder="Search screens…"
        autoComplete="off"
        className="input pl-10 pr-3 bg-gray-50 border-gray-200 focus:bg-white"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setFocused(true)}
        onKeyDown={onKeyDown}
      />

      {sheet ? (
        <div className="mt-2 -mx-1">{list}</div>
      ) : (
        showing && (
          <div className="absolute right-0 top-full mt-2 w-full min-w-[16rem] z-50 origin-top-right
                          rounded-2xl border border-gray-100 bg-white shadow-pop animate-scale-in
                          max-h-[60dvh] overflow-y-auto scroll-touch">
            {list}
          </div>
        )
      )}
    </div>
  );
}
