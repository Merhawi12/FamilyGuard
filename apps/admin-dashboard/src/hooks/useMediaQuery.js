import { useEffect, useState } from 'react';

/**
 * Tracks a CSS media query from JavaScript.
 *
 * Most responsive behaviour belongs in Tailwind's breakpoints, but the rail
 * renders *different markup* when it is collapsed — labels become tooltips,
 * section headers become dividers — and a class cannot swap markup. This is the
 * one place the layout needs to know the viewport it is actually on.
 */
export default function useMediaQuery(query) {
  const [matches, setMatches] = useState(
    () => (typeof window !== 'undefined' && window.matchMedia(query).matches)
  );

  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = (event) => setMatches(event.matches);
    setMatches(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
