import { useEffect, useRef } from 'react';
import Icon from './Icon.jsx';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock.js';

/**
 * A dialog that is a bottom sheet on a phone and a centred card on a desktop.
 *
 * A centred `max-w-md` card is fine with a mouse and poor on a phone: it lands
 * mid-screen, its controls sit far from the thumb, and a tall form inside it
 * has nowhere to scroll. The same content as a sheet anchored to the bottom
 * edge scrolls naturally and puts the primary button where the hand already is.
 *
 * Escape closes it, a click on the backdrop closes it, the page behind it stops
 * scrolling, and focus moves inside on open so a keyboard is not left behind on
 * the page underneath.
 */
export default function Modal({ open, onClose, title, description, children, footer, size = 'md' }) {
  const panelRef = useRef(null);

  useBodyScrollLock(open);

  // Escape closes. Re-subscribing when `onClose` changes identity is both cheap
  // and necessary — the listener has to call the current one.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  /**
   * Focus moves inside when the dialog opens — and only then.
   *
   * This used to share the effect above, so it re-ran whenever `onClose` changed
   * identity too. Every caller passes an inline arrow or a function declared in
   * its own body, so that is *every render of the parent* — and the parent
   * re-renders on every keystroke, because the fields inside are controlled by
   * its state. Typing a device name went: first character lands, focus is pulled
   * back to the first focusable element, every character after it goes nowhere,
   * and the first space activates that element. Which is the ✕ in the header,
   * because it precedes the content in DOM order. So the dialog closed itself
   * part-way through the word and threw away what had been typed.
   *
   * Depending on `open` alone is the whole fix: opening is the event that should
   * move focus, and nothing else here is.
   */
  useEffect(() => {
    if (!open) return;
    // The first focusable control inside, falling back to the panel itself.
    const first = panelRef.current?.querySelector(
      'input:not([type="hidden"]), select, textarea, button, [href], [tabindex]:not([tabindex="-1"])'
    );
    (first || panelRef.current)?.focus?.({ preventScroll: true });
  }, [open]);

  if (!open) return null;

  const width = size === 'lg' ? 'sm:max-w-2xl' : size === 'sm' ? 'sm:max-w-sm' : 'sm:max-w-md';

  return (
    <div className="fixed inset-0 z-50 flex sm:items-center sm:justify-center items-end">
      <div
        className="absolute inset-0 bg-gray-900/50 animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`relative w-full ${width} bg-white shadow-pop outline-none
                    rounded-t-3xl sm:rounded-2xl
                    max-h-[92dvh] sm:max-h-[86dvh] flex flex-col
                    animate-slide-up sm:animate-scale-in`}
      >
        {/* Grab handle — a sheet with one reads as draggable and dismissible. */}
        <div className="sm:hidden pt-3 pb-1 flex justify-center shrink-0">
          <span className="w-10 h-1 rounded-full bg-gray-200" />
        </div>

        <div className="flex items-start gap-3 px-5 pt-4 sm:pt-5 pb-3 shrink-0">
          <div className="flex-1 min-w-0">
            {title && <h2 className="section-title truncate">{title}</h2>}
            {description && <p className="text-sm text-gray-500 mt-1">{description}</p>}
          </div>
          <button type="button" onClick={onClose} className="icon-btn -mr-2 -mt-2" aria-label="Close">
            <Icon name="close" />
          </button>
        </div>

        <div className="px-5 pb-5 overflow-y-auto scroll-touch flex-1">{children}</div>

        {footer && (
          <div className="px-5 py-4 border-t border-gray-100 bg-gray-50 rounded-b-2xl shrink-0 pb-safe">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
