/**
 * The frame around every signed-out screen.
 *
 * Sign in, sign up, email and SMS verification, the two-factor challenge and the
 * password reset all sat inside their own copy of this card.
 *
 * The mark and the tagline live here rather than inside the card, and only once:
 * a card that repeats the product name under a header that already shows it
 * spends the top of a 667px phone screen saying "Parentix" twice, which is what
 * pushes the password field under the keyboard the moment it opens.
 *
 * There is deliberately no Privacy/Terms footer. Both pages stay reachable from
 * the places that actually need them — the consent line on the sign-up form,
 * which is the legally meaningful one, and the list in Settings — so repeating
 * them under every card only competed with the form for a small screen.
 *
 * The container's bottom pad carries the home-indicator inset that footer used
 * to hold via `pb-safe`. It only shows up when the card is taller than the
 * screen: a sign-up form on a short phone scrolls, and without it the last
 * field ends under the gesture bar.
 */
export default function AuthShell({ children }) {
  // The wash behind the card is built from brand tokens rather than a stock
  // hue. It was a blue-to-indigo gradient when the app was blue, and because a
  // gradient carries no colour token the retint went straight past it — so the
  // sign-in, sign-up, verification, two-factor and password-reset screens all
  // kept a lavender background behind a teal product. It is the first thing
  // anyone sees, and it was the last thing still blue.
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-gradient-to-br from-primary-50 via-white to-primary-100 px-4 pt-8 pb-[calc(2rem+env(safe-area-inset-bottom))]">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <a href="/" aria-label="Parentix home">
            <img src="/logo.png" alt="Parentix" className="h-16 sm:h-20 w-auto mx-auto" />
          </a>
          <p className="text-sm text-gray-500 mt-3">Parental Control &amp; Digital Safety</p>
        </div>

        <div className="bg-white rounded-3xl shadow-pop border border-gray-100 p-5 sm:p-8">
          {children}
        </div>
      </div>
    </div>
  );
}
