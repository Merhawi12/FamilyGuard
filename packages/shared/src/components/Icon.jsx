/**
 * The icon set for both web apps.
 *
 * The screens used to draw their icons with emoji. Emoji are rendered by the
 * operating system, so the same "🔔" is a flat glyph on one phone and a glossy
 * 3D bell on another, none of them sit on the text baseline, and none of them
 * take the surrounding text colour — which is why an emoji nav rail never quite
 * looks like it was designed. These are stroked SVG on a 24px grid: one visual
 * weight, `currentColor` throughout, sized in the same steps everywhere.
 *
 *   <Icon name="bell" />                  20px, inherits colour
 *   <Icon name="bell" size={24} />
 *   <Icon name="bell" className="text-primary-600" />
 *
 * Each entry is a fragment rather than an array so React never asks for keys on
 * shapes that are static element literals, not a rendered list.
 *
 * Decorative by default (`aria-hidden`): the label beside an icon is what a
 * screen reader should read. Pass `title` only when the icon is the entire
 * content of a control and that control has no `aria-label` of its own.
 */
const ICONS = {
  // ── Navigation ────────────────────────────────────────────────────────────
  dashboard: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
    </>
  ),
  children: (
    <>
      <path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" />
      <circle cx="9" cy="7" r="3.25" />
      <path d="M22 20v-1.5a4 4 0 0 0-3-3.87" />
      <path d="M16 4.13a4 4 0 0 1 0 5.74" />
    </>
  ),
  location: (
    <>
      <path d="M20 10.5c0 5.4-6.35 10.35-7.6 11.26a.7.7 0 0 1-.8 0C10.35 20.85 4 15.9 4 10.5a8 8 0 1 1 16 0Z" />
      <circle cx="12" cy="10.5" r="2.75" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5.2l3.2 1.9" />
    </>
  ),
  block: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </>
  ),
  activity: <path d="M3 12h3.5l2.5-7 4.5 14 2.5-7H21" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.5 9h17M3.5 15h17" />
      <path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z" />
    </>
  ),
  message: (
    <path d="M20.5 11.5a7.9 7.9 0 0 1-8.5 7.9 9 9 0 0 1-2.6-.4L4 20.5l1.4-4.6A7.7 7.7 0 0 1 4 11.5a7.9 7.9 0 0 1 8.3-7.9 8 8 0 0 1 8.2 7.9Z" />
  ),
  contacts: (
    <>
      <rect x="5" y="3" width="15" height="18" rx="2.5" />
      <circle cx="12.5" cy="10" r="2.5" />
      <path d="M9 17.5a3.7 3.7 0 0 1 7 0" />
      <path d="M2.5 8H5M2.5 12H5M2.5 16H5" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8.5a6 6 0 0 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5Z" />
      <path d="M10.3 19a2 2 0 0 0 3.4 0" />
    </>
  ),
  reports: (
    <>
      <path d="M4 4v16h16" />
      <path d="M8 16.5v-4" />
      <path d="M12.5 16.5v-8" />
      <path d="M17 16.5v-5.5" />
    </>
  ),
  settings: (
    <>
      <path d="M20 7h-8.5" />
      <path d="M13 17H4" />
      <circle cx="7.5" cy="7" r="2.75" />
      <circle cx="16.5" cy="17" r="2.75" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.75" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  // An account leaving — churn, a revoked seat. The plain `user` mark with the
  // same minus stroke the controls use, so the two read as one family.
  userMinus: (
    <>
      <circle cx="10" cy="8" r="3.75" />
      <path d="M2.5 20a7.5 7.5 0 0 1 13.2-4.85" />
      <path d="M16 19h5.5" />
    </>
  ),
  shield: <path d="M12 21s7-3.2 7-9V5.8l-7-2.6-7 2.6V12c0 5.8 7 9 7 9Z" />,
  shieldCheck: (
    <>
      <path d="M12 21s7-3.2 7-9V5.8l-7-2.6-7 2.6V12c0 5.8 7 9 7 9Z" />
      <path d="m9 11.8 2.2 2.2 4-4" />
    </>
  ),

  // ── Controls ──────────────────────────────────────────────────────────────
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  chevronRight: <path d="m9.5 5 7 7-7 7" />,
  chevronLeft: <path d="m14.5 5-7 7 7 7" />,
  chevronDown: <path d="m5 9 7 7 7-7" />,
  arrowLeft: (
    <>
      <path d="M20 12H4" />
      <path d="m10 6-6 6 6 6" />
    </>
  ),
  arrowRight: (
    <>
      <path d="M4 12h16" />
      <path d="m14 6 6 6-6 6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  check: <path d="m20 6.5-11 11-5-5" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  filter: <path d="M3.5 5.5h17l-6.5 8V20l-4 1.5v-8Z" />,
  refresh: (
    <>
      <path d="M20 11a8 8 0 0 0-13.8-5.2L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 13.8 5.2L20 16" />
      <path d="M20 20v-4h-4" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 6.5h15" />
      <path d="M9 6.5V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v1.5" />
      <path d="M6.5 6.5 7.4 19a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9l.9-12.5" />
    </>
  ),
  edit: (
    <>
      <path d="M12 20h8" />
      <path d="M16.5 3.9a2.1 2.1 0 0 1 3 3L8.5 17.9 4 19l1.1-4.5Z" />
    </>
  ),
  upload: (
    <>
      <path d="M20 15.5V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3.5" />
      <path d="m8 8 4-4 4 4" />
      <path d="M12 4v12" />
    </>
  ),
  download: (
    <>
      <path d="M20 15.5V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3.5" />
      <path d="m8 11 4 4 4-4" />
      <path d="M12 3v12" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2.5" />
      <path d="M15 6V5.5A2.5 2.5 0 0 0 12.5 3h-7A2.5 2.5 0 0 0 3 5.5v7A2.5 2.5 0 0 0 5.5 15H6" />
    </>
  ),
  logout: (
    <>
      <path d="M10 21H6a2.5 2.5 0 0 1-2.5-2.5v-13A2.5 2.5 0 0 1 6 3h4" />
      <path d="m16 16 4-4-4-4" />
      <path d="M20 12H9.5" />
    </>
  ),
  external: (
    <>
      <path d="M13 4h7v7" />
      <path d="M20 4 11 13" />
      <path d="M18.5 14v4.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2H10" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M10.6 6.7A8.7 8.7 0 0 1 12 6.5c6 0 9.5 5.5 9.5 5.5a17 17 0 0 1-3 3.8" />
      <path d="M6.5 7.8A16.6 16.6 0 0 0 2.5 12s3.5 6 9.5 6a9 9 0 0 0 4-.9" />
      <path d="m3.5 3.5 17 17" />
      <path d="M9.9 10.2a3 3 0 0 0 4.1 4.2" />
    </>
  ),
  send: (
    <>
      <path d="M21 3.5 10.5 14" />
      <path d="M21 3.5 14.5 21l-4-7-7-4Z" />
    </>
  ),
  link: (
    <>
      <path d="M10 13.5a4 4 0 0 0 5.7.4l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.6 1.6" />
      <path d="M14 10.5a4 4 0 0 0-5.7-.4l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.6-1.6" />
    </>
  ),

  // ── Objects ───────────────────────────────────────────────────────────────
  phone: (
    <>
      <rect x="6" y="2.5" width="12" height="19" rx="3" />
      <path d="M10.75 18.5h2.5" />
    </>
  ),
  laptop: (
    <>
      <rect x="4" y="5" width="16" height="11" rx="2" />
      <path d="M2.5 19.5h19" />
    </>
  ),
  desktop: (
    <>
      <rect x="2.5" y="4" width="19" height="12.5" rx="2.5" />
      <path d="M12 16.5v4" />
      <path d="M8.5 20.5h7" />
    </>
  ),
  // A fleet rather than one machine: the console's device screen, and the label
  // for a mixed set of hardware.
  devices: (
    <>
      <path d="M13.5 15.5H4a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 4 4.5h12A1.5 1.5 0 0 1 17.5 6v1.5" />
      <path d="M6 18.5h5" />
      <rect x="15" y="9.5" width="6.5" height="11" rx="1.75" />
    </>
  ),
  // Four nodes and the links between them: the shape of a fleet reporting to one
  // service, used as the label for the console's topology view.
  network: (
    <>
      <path d="M8.5 6.5h7M6.5 8.5v7M17.5 8.5v7M8.5 17.5h7" />
      <rect x="3.5" y="3.5" width="4" height="4" rx="1.25" />
      <rect x="16.5" y="3.5" width="4" height="4" rx="1.25" />
      <rect x="3.5" y="16.5" width="4" height="4" rx="1.25" />
      <rect x="16.5" y="16.5" width="4" height="4" rx="1.25" />
    </>
  ),
  call: (
    <path d="M6.2 3.5h2.6l1.6 4-2 1.3a11.5 11.5 0 0 0 5.3 5.3l1.3-2 4 1.6v2.6a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.2 5.7a2 2 0 0 1 2-2.2Z" />
  ),
  mail: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="m3.5 7.5 7.4 5.2a2 2 0 0 0 2.2 0l7.4-5.2" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10" width="15" height="11" rx="2.5" />
      <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
    </>
  ),
  card: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M2.5 10h19" />
      <path d="M6.5 14.5h3" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M8.5 13h7M8.5 16.5h4.5" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <circle cx="8.5" cy="10" r="1.5" />
      <path d="m4 17 4.6-4.3a2 2 0 0 1 2.7 0L20 20" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="16" rx="2.5" />
      <path d="M3.5 10h17" />
      <path d="M8 3v4M16 3v4" />
    </>
  ),
  inbox: (
    <>
      <path d="M3.5 13h4l1.5 2.5h6L16.5 13h4" />
      <path d="M5.4 5.4A2 2 0 0 1 7.2 4h9.6a2 2 0 0 1 1.8 1.4L21 13v4.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5V13Z" />
    </>
  ),
  warning: (
    <>
      <path d="M10.3 4.3 2.6 17.4A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3.1L13.7 4.3a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4M12 17h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.8h.01" />
    </>
  ),
  sparkle: (
    <>
      <path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z" />
      <path d="M18.5 15.5 19 17l1.5.5-1.5.5-.5 1.5-.5-1.5L16.5 17l1.5-.5Z" />
    </>
  ),
  qr: (
    <>
      <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="14" y="3.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="3.5" y="14" width="6.5" height="6.5" rx="1.5" />
      <path d="M14 14h3v3h-3zM20.5 14v3M17.5 20.5h3M14 20.5h.01" />
    </>
  ),
};

export default function Icon({
  name,
  size = 20,
  strokeWidth = 1.75,
  className = '',
  title,
  ...rest
}) {
  const shapes = ICONS[name];
  if (!shapes) return null;

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {title && <title>{title}</title>}
      {shapes}
    </svg>
  );
}
