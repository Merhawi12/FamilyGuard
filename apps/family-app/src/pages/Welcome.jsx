import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@parentix/shared';
import { markWelcomeSeen } from '../services/welcome';

/**
 * The first screen of the installed app.
 *
 * Someone opening Parentix for the first time has a sign-in form and no idea
 * what they are signing in to — the pitch lives on the marketing site, which is
 * not shipped inside the app. These three cards are that pitch, cut to the three
 * things the product actually does, and they are shown once.
 *
 * "Get Started" is on every card rather than only the last. A splash is not a
 * tutorial, and making a parent tap through three screens to reach a sign-in
 * form they were already looking for is a toll, not an introduction. The dots
 * and the swipe are there for anyone who wants the rest; nobody is held.
 */

const SLIDES = [
  {
    // The mark itself, which is the whole of the first card: the app has just
    // been opened from an icon, and the first thing to confirm is that this is
    // the thing they installed.
    logo: true,
    title: 'Parentix',
    body: "Calm vigilance for your family's digital life.",
  },
  {
    icon: 'clock',
    title: 'See their day at a glance',
    body: 'Screen time, the apps they use and the sites they visit — summarised, so you do not have to read over a shoulder.',
  },
  {
    icon: 'location',
    title: 'Know they arrived',
    body: 'Safe zones tell you when they get to school or home. Everything else stays quiet until it matters.',
  },
];

/** How far a finger must travel before it counts as a swipe rather than a tap. */
const SWIPE_THRESHOLD_PX = 48;

export default function Welcome() {
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);
  const startX = useRef(null);

  const go = useCallback((next) => {
    setIndex(Math.max(0, Math.min(SLIDES.length - 1, next)));
  }, []);

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
    <div className="relative min-h-dvh overflow-hidden">
      {/*
        The photograph is decoration, not content — it carries no information a
        screen reader would want, and the copy on top of it says everything. It
        is a background rather than an <img> for that reason.
      */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: 'url(/hero.webp)' }}
      />
      {/*
        Text over a photograph has whatever contrast that pixel happens to give.
        Washing the whole image to near-white first makes it predictable: the
        headline and body below are then measured against white, which they pass
        comfortably, instead of against a stranger's living room.
      */}
      <div aria-hidden="true" className="absolute inset-0 bg-white/85" />
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-white via-white/90 to-transparent" />

      <div
        className="relative min-h-dvh flex flex-col items-center justify-between px-6 pt-safe touch-pan-y"
        style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom, 0px))' }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { startX.current = null; }}
      >
        <div className="flex-1 flex flex-col items-center justify-center text-center max-w-sm">
          <div className="w-32 h-32 sm:w-36 sm:h-36 rounded-3xl bg-white shadow-pop flex items-center justify-center mb-8">
            {slide.logo
              ? <img src="/logo.png" alt="Parentix" className="w-24 sm:w-28 h-auto" />
              : <Icon name={slide.icon} size={52} className="text-primary-600" />}
          </div>

          {/*
            `aria-live` so paging the carousel is announced. Without it the only
            thing that changes for a screen-reader user is which dot is pressed,
            which says a slide moved but never what it said.
          */}
          <div aria-live="polite">
            <h1 className="text-4xl font-bold text-gray-900 tracking-tight">{slide.title}</h1>
            <p className="text-lg text-gray-600 mt-4 leading-snug">{slide.body}</p>
          </div>
        </div>

        <div className="w-full max-w-sm shrink-0">
          <div className="flex justify-center items-center gap-1 mb-6" role="tablist" aria-label="Introduction">
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
                className="w-11 h-11 flex items-center justify-center rounded-full"
              >
                <span
                  className={`block rounded-full transition-all duration-200 motion-reduce:transition-none ${
                    i === index ? 'w-6 h-2 bg-primary-600' : 'w-2 h-2 bg-primary-200'
                  }`}
                />
              </button>
            ))}
          </div>

          <button type="button" onClick={start} className="btn-primary btn-block">
            Get Started
            <Icon name="arrowRight" size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
