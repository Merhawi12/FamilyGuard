import { useEffect, useRef, useState } from 'react';

/**
 * Open/closed state for a popover that closes the way users expect it to:
 * clicking anywhere outside it, or pressing Escape.
 *
 * Returns a ref to put on the popover's outermost element. Without this a
 * dropdown stays open until its own button is clicked again, so two of them can
 * sit open on top of each other.
 *
 * @returns {{ open: boolean, setOpen: (v: boolean) => void, toggle: () => void, ref: object }}
 */
export function useDismissable(initial = false) {
  const [open, setOpen] = useState(initial);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return { open, setOpen, toggle: () => setOpen((v) => !v), ref };
}
