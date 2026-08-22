import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BrandLogo, Icon } from '@parentix/shared';
import { markWelcomeSeen } from '../services/welcome';

/**
 * The first screen of the installed app.
 *
 * Someone opening Parentix for the first time has a sign-in form and no idea
 * what they are signing in to — the pitch lives on the marketing site, which is
 * not shipped inside the app. These three cards are that pitch, cut to the three
 * things the product actually does, and they are shown once.
 *
 * The shape is a photograph above a sheet: the family photo fills the top of the
 * screen, the white sheet slides up over its bottom edge with rounded corners,
 * and the brand tile straddles the seam between them. That split is what lets
 * the screen be warm and legible at the same time — the photograph never has to
 * carry text, so nothing is measured against a stranger's living room, and the
 * copy sits on flat white where it is guaranteed to pass contrast.
 *
 * "Get Started" is on every card rather than only the last. A splash is not a
 * tutorial, and making a parent tap through three screens to reach a sign-in
 * form they were already looking for is a toll, not an introduction. The dots
 * and the swipe are there for anyone who wants the rest; nobody is held.
 */

/**
 * The photograph behind the top of the screen.
 *
 * The same file the marketing hero uses, deliberately: the app store listing,
 * parentix.ca and the first screen of the app should not be three different
 * living rooms. Replacing `public/hero.webp` re-themes both surfaces at once,
 * and nothing here is cropped to a particular subject — `object-position` keeps
 * the upper-middle of any portrait photo in frame, which is where faces are.
 */
const HERO = '/hero.webp';

const SLIDES = [
  {
    // The mark itself, which is the whole of the first card: the app has just
    // been opened from an icon, and the first thing to confirm is that this is
    // the thing they installed.
    logo: true,
    eyebrow: 'Welcome to',
    title: 'Parentix',
    body: "Calm vigilance for your family's digital life.",
  },
  {
    icon: 'clock',
    eyebrow: 'Screen time',
    title: 'See their day at a glance',
    body: 'Screen time, the apps they use and the sites they visit — summarised, so you do not have to read over a shoulder.',
  },
  {
    icon: 'location',
    eyebrow: 'Safe zones',
    title: 'Know they arrived',
    body: 'Safe zones tell you when they get to school or home. Everything else stays quiet until it matters.',
  },
];

/** How far a finger must travel before it counts as a swipe rather than a tap. */
const SWIPE_THRESHOLD_PX = 48;

export default function Welcome() {
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);
  // Which way the last move went, so the incoming card enters from the side the
  // finger came from rather than always from the right.
  const [dir, setDir] = useState(1);
  const startX = useRef(null);

  const go = useCallback((next) => {
    const clamped = Math.max(0, Math.min(SLIDES.length - 1, next));
    // Bailing on a no-op matters here: swiping past the last card or tapping the
    // dot you are already on would otherwise re-key the copy and replay the
    // entrance animation, which reads as the screen glitching rather than as a
    // move that was refused.
    if (clamped === index) return;
    setDir(clamped > index ? 1 : -1);
    setIndex(clamped);
  }, [index]);

  const start = useCallback(() => {
    markWelcomeSeen();
    navigate('/login', { replace: true });
  }, [navigate]);

  // Arrow keys page the carousel, because the dots are buttons and a keyboard
  // user who has just tabbed to them expects them to behave like a group.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'ArrowRight') go(index + 1);
      if (e.key === 'ArrowLeft') go(index - 1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [index, go]);

  const onPointerDown = (e) => { startX.current = e.clientX; };
  const onPointerUp = (e) => {
    if (startX.current === null) return;
    const dx = e.clientX - startX.current;
    startX.current = null;
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
    go(index + (dx < 0 ? 1 : -1));
  };

  const slide = SLIDES[index];

  return (
    <div
      className="relative flex min-h-dvh flex-col bg-primary-800 touch-pan-y wide:flex-row"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { startX.current = null; }}
    >
      {/*
        The stage.

        `bg-primary-800` is on the container rather than only behind the photo so
        the very first painted frame of a cold launch is already brand teal —
        there is no white flash while a 78KB image decodes, and if the file is
        missing entirely the screen still looks deliberate. The image itself is an
        <img> rather than a CSS background for the same reason it carries
        `fetchpriority`: a background is not requested until the box holding it has
        been laid out, which on the one screen where startup time is visible is
        exactly the wrong moment to start a fetch.

        The photograph is what absorbs the difference between one screen and the
        next, and that is the whole of the vertical layout. Its height is not a
        fraction of the viewport: the sheet below is sized by its own copy, which
        is roughly the same number of pixels on every phone, so a percentage
        split leaves a tall phone with a field of empty white and squeezes a
        short one. Instead the sheet takes what it needs (`flex-auto` — it grows,
        but never below its content) and the picture takes five sixths of
        whatever is left, bounded so it can never swallow the screen or vanish.
        `basis-0` is what makes "what is left" mean the whole free height rather
        than the free height minus an intrinsic image.
      */}
      <div className="relative w-full shrink-0 grow-[5] basis-0 overflow-hidden max-h-[54dvh] min-h-[190px] md:max-h-[62dvh] wide:h-auto wide:max-h-none wide:min-h-0 wide:grow-0 wide:basis-auto wide:w-[46%] short:w-[40%]">
        {/*
          `fetchpriority` is lowercase deliberately, and the lint rule is
          suppressed rather than the spelling corrected. React 18.3 does not know
          `fetchPriority` as a DOM prop: it strips it, lowercases it and logs a
          console error on the way — and the introduction is one of the screens
          `scripts/browser-e2e.mjs` fails on any console error at all, on the
          grounds that a throw on the first screen of an install is a blank
          launch. Lowercase passes through untouched and silent, which is the
          spelling the browser wanted in the first place.
        */}
        <img
          src={HERO}
          alt=""
          aria-hidden="true"
          draggable="false"
          // eslint-disable-next-line react/no-unknown-property
          fetchpriority="high"
          decoding="async"
          className="splash-drift absolute inset-0 h-full w-full select-none object-cover object-[center_38%]"
        />
        {/*
          Two washes, and they do different jobs. The teal is brand — it is what
          stops the photograph reading as a stock image dropped into a white app.
          The vertical gradient is depth: it darkens the bottom edge so the white
          sheet appears to lift off the picture rather than being pasted onto it.
        */}
        <div aria-hidden="true" className="absolute inset-0 bg-primary-800/20" />
        <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-b from-gray-900/35 via-transparent to-gray-900/45 wide:to-gray-900/25" />
      </div>

      {/*
        The sheet. It overlaps the photograph by 32px on a phone, which is what
        makes the rounded corners read — a rounded rectangle flush against the
        bottom of an image just looks like a mistake. On a wide screen the two
        become side-by-side columns instead and the overlap is dropped, because a
        sheet that "slides up" over nothing is a phone idiom on a desktop.
      */}
      <div
        className="relative -mt-8 flex flex-auto flex-col rounded-t-[2rem] bg-white px-6 shadow-pop xl:px-16 wide:mt-0 wide:justify-center wide:rounded-none wide:px-12 wide:shadow-none short:px-7"
        style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom, 0px))' }}
      >
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col wide:flex-none">
          {/*
            The tile straddles the seam. Keyed on the slide so it re-animates
            when the card changes; `shadow-pop` and the hairline ring are what
            hold it off the photograph behind it.
          */}
          <div
            key={`tile-${index}`}
            className="splash-pop -mt-14 flex h-28 w-28 shrink-0 items-center justify-center rounded-[1.75rem] bg-white shadow-pop ring-1 ring-gray-100 wide:mt-0 wide:h-24 wide:w-24 short:h-16 short:w-16 short:rounded-2xl"
          >
            {slide.logo
              ? <BrandLogo className="h-auto w-20 wide:w-16 short:w-11" />
              : (
                <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-50 text-primary-600 wide:h-14 wide:w-14 short:h-10 short:w-10 short:rounded-xl">
                  <Icon name={slide.icon} size={32} />
                </span>
              )}
          </div>

          {/*
            `aria-live` so paging the carousel is announced. Without it the only
            thing that changes for a screen-reader user is which dot is pressed,
            which says a slide moved but never what it said.
          */}
          <div aria-live="polite" className="mt-7 wide:mt-8 short:mt-4">
            <div
              key={`copy-${index}`}
              className={dir > 0 ? 'splash-enter-right' : 'splash-enter-left'}
            >
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-600">
                {slide.eyebrow}
              </p>
              <h1 className="mt-2 text-[1.7rem] font-bold leading-[1.15] tracking-tight text-gray-900 sm:text-4xl short:text-2xl">
                {slide.title}
              </h1>
              <p className="mt-3 text-[0.95rem] leading-relaxed text-gray-500 sm:mt-4 sm:text-lg short:mt-2 short:text-sm short:leading-snug">
                {slide.body}
              </p>
            </div>
          </div>

          {/* Eats the slack on a tall phone so the button stays at the bottom of
              the screen. On a wide screen the column is centred instead. */}
          <div className="min-h-[1.5rem] flex-1 wide:hidden" />

          <div className="shrink-0 wide:mt-10 short:mt-4">
            <div className="mb-4 flex items-center justify-center gap-1 wide:justify-start short:mb-1" role="tablist" aria-label="Introduction">
              {SLIDES.map((s, i) => (
                /*
                  The dot is 8px and the button around it is 44px, the same trick
                  the sidebar's section headings use. A control this small is not
                  reliably hittable on a phone, and growing the dot to fix that
                  would make it a bullet rather than an indicator.
                */
                <button
                  key={s.title}
                  type="button"
                  role="tab"
                  aria-selected={i === index}
                  aria-label={`${s.title} — slide ${i + 1} of ${SLIDES.length}`}
                  onClick={() => go(i)}
                  className="flex h-11 w-11 items-center justify-center rounded-full"
                >
                  <span
                    className={`block rounded-full transition-all duration-300 motion-reduce:transition-none ${
                      i === index ? 'h-2 w-7 bg-primary-600' : 'h-2 w-2 bg-primary-200'
                    }`}
                  />
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={start}
              className="btn-primary btn-block h-14 rounded-2xl text-base shadow-lg shadow-primary-600/30 transition active:scale-[.985] motion-reduce:active:scale-100 short:h-12 short:text-[0.95rem]"
            >
              Get Started
              <Icon name="arrowRight" size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
