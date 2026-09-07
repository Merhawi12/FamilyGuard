/**
 * The moving water behind every signed-out screen.
 *
 * ── Why this is drawn rather than photographed ───────────────────────────────
 *
 * The brief asked for a background *image* with a flowing-water animation, and
 * those two things pull against each other: a raster image cannot flow. The
 * ways to make one appear to are a video, an animated GIF or a sprite sheet —
 * all of which mean hundreds of kilobytes and a decoder running on the first
 * screen a parent ever sees, on the slowest connection they will ever use us
 * on, in front of a form they are trying to fill in.
 *
 * The reference art is overlapping translucent ribbons with soft edges, and
 * that is a thing SVG draws natively. So it is drawn. It costs no bytes over
 * the markup, needs no art direction for the range of shapes between a 360px
 * phone and a widescreen desktop, stays sharp at every pixel ratio, and — the
 * point — it can actually move.
 *
 * ── Why ribbons and not blurred blobs ───────────────────────────────────────
 *
 * The first attempt was radial gradients with `mix-blend-mode: soft-light`, and
 * it rendered as a flat pale wash: soft-light between two light colours barely
 * changes either, so the shapes were technically present and visually absent.
 * Screenshotting it is what showed that — every behavioural check had passed.
 *
 * Real paths with real fills give the reference's defining feature, which is
 * *edges*: the places where two translucent ribbons cross and make a third
 * tone. That is what reads as water rather than as a gradient.
 *
 * ── How it moves ────────────────────────────────────────────────────────────
 *
 * Each ribbon drifts on its own slow, mutually prime duration (29s, 37s, 43s,
 * 53s, 61s), so the composite never visibly repeats — the loop is their lowest
 * common multiple, which is measured in weeks. Water reads as water because
 * nothing in it returns to where it was.
 *
 * Every animation is `transform` only. That keeps the whole thing on the
 * compositor: no layout, no repaint, nothing competing with a keyboard opening
 * or a form validating. Each path is drawn far wider than the viewBox so a
 * drift can never pull an edge into view.
 *
 * ── Why it cannot interfere ─────────────────────────────────────────────────
 *
 * `pointer-events-none` and `aria-hidden`, so it takes no taps and adds nothing
 * to the accessibility tree. `fixed inset-0` with `overflow-hidden`, so drifting
 * shapes leave the viewport without ever producing a scrollbar — a horizontal
 * one on a login screen is how a phone ends up scrolled sideways with the
 * password field half off it. It sits at z-index 0 rather than a negative
 * value, because `body` is painted `bg-gray-50` and a negative z-index puts an
 * element behind its ancestors' backgrounds — which rendered the water
 * invisible. The card above is lifted with `relative z-10`.
 *
 * The palette is the brand's, not a stock aqua, and that matters here
 * specifically: this app's auth background was a hardcoded blue-to-indigo
 * gradient that survived the entire teal rebrand *because a gradient carries no
 * colour token*, so the sign-in screen stayed lavender in front of a teal
 * product. The stops below are the `teal` scale from tailwind.config.js.
 */
export default function AuthBackground() {
  return (
    <div className="auth-water" aria-hidden="true">
      {/*
        `slice` rather than `none`: the viewBox is portrait and the desktop
        viewport is landscape, so stretching to fit would flatten every curve
        into a horizontal smear. Slicing keeps the shapes' proportions and crops
        instead, which is why each path runs well past the viewBox on both
        sides — there is nothing to see at the edges to crop *to*.
      */}
      <svg
        className="auth-water__canvas"
        viewBox="0 0 400 800"
        preserveAspectRatio="xMidYMid slice"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* The body of the water. */}
          <linearGradient id="pxWash" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#d9f6f7" />
            <stop offset="45%" stopColor="#a8e6ea" />
            <stop offset="100%" stopColor="#cdf1e3" />
          </linearGradient>

          {/* Each ribbon fades along its own axis, so where two cross there are
              three tones rather than two — the thing that reads as depth. */}
          <linearGradient id="pxRibbonA" x1="0" y1="0" x2="1" y2="0.6">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0.15" />
          </linearGradient>
          <linearGradient id="pxRibbonB" x1="0.2" y1="0" x2="0.9" y2="1">
            <stop offset="0%" stopColor="#7fd4dd" stopOpacity="0.75" />
            <stop offset="100%" stopColor="#a8ecf2" stopOpacity="0.15" />
          </linearGradient>
          <linearGradient id="pxRibbonC" x1="0" y1="0.2" x2="1" y2="1">
            <stop offset="0%" stopColor="#b8ecd8" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#d9f6f7" stopOpacity="0.1" />
          </linearGradient>
          <linearGradient id="pxDeep" x1="0" y1="0" x2="1" y2="0.4">
            <stop offset="0%" stopColor="#2f4a58" />
            <stop offset="100%" stopColor="#4a6b78" />
          </linearGradient>
          <radialGradient id="pxGlow" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
        </defs>

        <rect x="-200" y="-200" width="800" height="1200" fill="url(#pxWash)" />

        {/* Upper ribbon — the pale crest across the top third. */}
        <path
          className="auth-water__ribbon auth-water__ribbon--a"
          fill="url(#pxRibbonA)"
          d="M-200 150 C -40 60, 60 250, 200 175 S 430 60, 620 140 L 620 -200 L -200 -200 Z"
        />

        {/* Mid ribbon — the aqua S-curve that gives the composition its spine. */}
        <path
          className="auth-water__ribbon auth-water__ribbon--b"
          fill="url(#pxRibbonB)"
          d="M-200 380 C -20 300, 70 470, 220 400 S 450 290, 620 370 L 620 620 C 430 700, 300 540, 180 610 S -40 700, -200 640 Z"
        />

        {/* Mint ribbon — crosses the other two, which is where the third tone
            comes from. */}
        <path
          className="auth-water__ribbon auth-water__ribbon--c"
          fill="url(#pxRibbonC)"
          d="M-200 500 C 0 420, 90 600, 260 520 S 480 420, 620 500 L 620 900 L -200 900 Z"
        />

        {/* The light on the water. */}
        <ellipse
          className="auth-water__glow"
          cx="330" cy="330" rx="230" ry="200"
          fill="url(#pxGlow)"
        />
      </svg>

      {/*
        The dark wave lives in its own element, anchored to the bottom of the
        viewport, and that is not tidiness — it is the only way it survives.
        The canvas above is `slice`d, so a portrait viewBox in a landscape
        window crops vertically and hard: at 1280×900 the browser shows about a
        quarter of the artwork's height, and a wave drawn at the bottom of the
        viewBox is simply not on screen. It was not, and the desktop screenshot
        is what showed it.

        Anchored here instead, with `preserveAspectRatio="none"` and a height in
        `vh`, it sits along the bottom edge at every aspect ratio — the phone,
        the desktop, and the short landscape window a laptop gives you when the
        keyboard is open.
      */}
      <svg
        className="auth-water__wave"
        viewBox="0 0 400 120"
        preserveAspectRatio="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="pxDeepBand" x1="0" y1="0" x2="1" y2="0.8">
            <stop offset="0%" stopColor="#33505f" />
            <stop offset="55%" stopColor="#3f6373" />
            <stop offset="100%" stopColor="#5c8593" />
          </linearGradient>
        </defs>
        {/* Two bands: a pale one riding above the dark one, which is what makes
            an edge read as a surface rather than as a block of colour. */}
        <path
          className="auth-water__wave-crest"
          fill="#ffffff"
          opacity="0.34"
          d="M0 46 C 70 18, 130 74, 210 50 S 340 12, 400 40 L 400 120 L 0 120 Z"
        />
        <path
          className="auth-water__wave-deep"
          fill="url(#pxDeepBand)"
          opacity="0.82"
          d="M0 70 C 80 42, 140 96, 225 72 S 345 40, 400 64 L 400 120 L 0 120 Z"
        />
      </svg>

      {/*
        A veil, not decoration. The mark and the tagline above the card are the
        only text that meets the background directly, and a drifting layer means
        their contrast changes over the course of a minute. This lifts the top
        of the screen towards white so the worst moment is still legible —
        gently, because the first version at 72% flattened the art it was
        protecting.
      */}
      <div className="auth-water__veil" />
    </div>
  );
}
