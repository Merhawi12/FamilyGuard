import { Link } from 'react-router-dom';

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
 */
export default function AuthShell({ children }) {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-gradient-to-br from-blue-50 via-white to-indigo-50 px-4 py-8">
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

        <div className="flex justify-center gap-5 mt-6 pb-safe">
          <Link to="/privacy-policy" className="text-xs text-gray-400 hover:text-gray-600">Privacy</Link>
          <Link to="/terms" className="text-xs text-gray-400 hover:text-gray-600">Terms</Link>
        </div>
      </div>
    </div>
  );
}
