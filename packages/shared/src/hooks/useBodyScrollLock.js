import { useEffect } from 'react';

/**
 * Stops the page behind an open drawer or sheet from scrolling.
 *
 * Without this, dragging on a mobile overlay scrolls the document underneath
 * it, so closing the sheet drops the parent somewhere they never navigated to.
 * The scroll position is pinned rather than merely hidden, because
 * `overflow: hidden` alone lets iOS Safari jump the document to the top.
 */
export function useBodyScrollLock(locked) {
  useEffect(() => {
    if (!locked) return undefined;

    const { body } = document;
    const y = window.scrollY;
    const previous = {
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      overflow: body.style.overflow,
    };

    body.style.position = 'fixed';
    body.style.top = `-${y}px`;
    body.style.width = '100%';
    body.style.overflow = 'hidden';

    return () => {
      Object.assign(body.style, previous);
      window.scrollTo(0, y);
    };
  }, [locked]);
}

export default useBodyScrollLock;
