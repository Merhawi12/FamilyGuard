/**
 * The line of context under the header, plus whatever the page's primary
 * action is.
 *
 * The title itself belongs to the header — see `Layout` — so this is only the
 * description and the action, laid out so a long button label wraps onto its
 * own row on a phone instead of squeezing the sentence beside it.
 */
export default function PageIntro({ description, children }) {
  if (!description && !children) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
      {description && <p className="text-sm text-gray-500 min-w-0 flex-1">{description}</p>}
      {children && <div className="flex items-center gap-2 shrink-0">{children}</div>}
    </div>
  );
}
