import { Link } from 'react-router-dom';
import { BrandLogo, Icon, useAuth } from '@parentix/shared';

/**
 * The shell around the Privacy Policy and the Terms.
 *
 * Both pages carried their own copy of the same header, title block and
 * footer — including a 64px logo and two full-size buttons that did not fit
 * across a phone, twice over. One shell, so a fix lands on both.
 *
 * ## It has to know whether anyone is signed in
 *
 * These are public routes, deliberately: they are linked from the sign-in screen
 * and from the marketing site, and a visitor deciding whether to sign up has to
 * be able to read the terms first. But they are *also* linked from Settings, and
 * a signed-in parent who tapped Privacy Policy used to arrive at a page headed
 * "Sign in / Get started" with no dashboard chrome anywhere on it. Their session
 * was completely intact — the token never moved — but nothing on the screen said
 * so, and the only obvious way out was the logo, which went to `/` and from
 * there to the marketing site. A parent doing that has, as far as they can tell,
 * been logged out by reading the privacy policy.
 *
 * So the shell asks. Signed in: one button back to the dashboard, and the logo
 * goes there too. Signed out: exactly what it always did.
 *
 * `loading` is treated as signed-out rather than blocking on it. The auth check
 * is a network call, and holding a static legal document behind a spinner to
 * find out which of two links to draw is a worse trade than briefly showing the
 * public header — which is also what a visitor with no session will keep.
 */
export default function LegalPage({ title, updated, children }) {
  const { user } = useAuth();
  const home = user ? '/dashboard' : '/';

  return (
    <div className="min-h-dvh bg-white flex flex-col">
      <header className="sticky top-0 z-40 bg-white/90 backdrop-blur-md border-b border-gray-100">
        {/* The bar grows with the mark rather than cropping it — 64px on a phone,
            80px from `sm` up, which is the same height AuthShell gives it. */}
        <div className="max-w-5xl mx-auto h-16 sm:h-20 px-4 sm:px-6 flex items-center justify-between gap-3">
          <Link to={home} className="shrink-0">
            {/* `logo.png` is the 500×500 *square* lockup — the shield stacked over
                the wordmark — so its height is shared between the two. At the h-9
                this used to be, the whole lockup was 36px and the word "Parentix"
                under it came out around 8px: present, and unreadable. Every other
                placement of this mark is 48–80px (AuthShell h-16 sm:h-20, Sidebar
                h-12 lg:h-16); this was the one outlier.

                It was shrunk for a reason — see the header comment, where the old
                per-page copies paired a 64px logo with two *full-size* buttons and
                overflowed a phone. Those are `btn-sm` now, so the room is there. */}
            <BrandLogo className="h-11 sm:h-14 w-auto" />
          </Link>
          <div className="flex items-center gap-2">
            {user ? (
              <Link to="/dashboard" className="btn-secondary btn-sm">
                <Icon name="chevronLeft" size={16} />
                Back to dashboard
              </Link>
            ) : (
              <>
                <Link to="/login" className="btn-ghost btn-sm hidden sm:inline-flex">Sign in</Link>
                <Link to="/login" className="btn-primary btn-sm">Get started</Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 sm:px-6 py-10 sm:py-16">
        <div className="max-w-3xl mx-auto">
          <span className="badge-primary uppercase tracking-wide">Legal</span>
          <h1 className="text-3xl sm:text-4xl font-extrabold text-gray-900 mt-4 mb-2 tracking-tight">
            {title}
          </h1>
          <p className="text-sm text-gray-500">Last updated: {updated}</p>

          <div className="mt-10 space-y-9 text-gray-600 leading-relaxed break-words">{children}</div>

          {/* Repeated at the end of the document, because these are long and the
              header has scrolled far out of reach by the time anyone finishes
              one. Only for a signed-in reader: a visitor has the marketing
              footer below and nothing to go back to. */}
          {user && (
            <div className="mt-12 pt-8 border-t border-gray-100">
              <Link to="/dashboard" className="btn-secondary">
                <Icon name="chevronLeft" size={16} />
                Back to dashboard
              </Link>
            </div>
          )}
        </div>
      </main>

      <footer className="bg-gray-900 px-4 py-10 text-center pb-safe">
        <Link to={home}>
          {/* Same square-lockup problem, and worse here: this one sits on a dark
              background at 80% opacity, so a 36px wordmark was fainter still. */}
          <BrandLogo className="h-14 w-auto mx-auto mb-4 opacity-80" />
        </Link>
        <div className="flex justify-center gap-6 mb-4">
          <Link to="/privacy-policy" className="text-gray-400 hover:text-white text-sm transition">
            Privacy Policy
          </Link>
          <Link to="/terms" className="text-gray-400 hover:text-white text-sm transition">
            Terms of Service
          </Link>
        </div>
        <p className="text-gray-400 text-sm">
          &copy; {new Date().getFullYear()} Parentix. Parental Control &amp; Digital Safety.
        </p>
      </footer>
    </div>
  );
}
