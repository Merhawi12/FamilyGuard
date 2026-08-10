import { useCallback, useState } from 'react';

/**
 * `useState` backed by localStorage, so a layout preference — a collapsed rail,
 * a folded nav section — survives a reload instead of resetting on every visit.
 *
 * Storage can throw (Safari private browsing, a blocked origin); a preference
 * is never worth an unhandled error, so a failure just means it is not kept.
 */
export default function usePersistentState(key, fallback) {
  const [value, setValue] = useState(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  });

  const store = useCallback((next) => {
    setValue((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      try {
        window.localStorage.setItem(key, JSON.stringify(resolved));
      } catch { /* nothing to do — the preference just will not persist */ }
      return resolved;
    });
  }, [key]);

  return [value, store];
}
