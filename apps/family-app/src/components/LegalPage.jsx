import { Link } from 'react-router-dom';

/**
 * The shell around the Privacy Policy and the Terms.
 *
 * Both pages carried their own copy of the same header, title block and
 * footer — including a 64px logo and two full-size buttons that did not fit
 * across a phone, twice over. One shell, so a fix lands on both.
 */
export default function LegalPage({ title, updated, children }) {
  return (
    <div className="min-h-dvh bg-white flex flex-col">
      <header className="sticky top-0 z-40 bg-white/90 backdrop-blur-md border-b border-gray-100">
        <div className="max-w-5xl mx-auto h-16 px-4 sm:px-6 flex items-center justify-between gap-3">
          <Link to="/" className="shrink-0">
            <img src="/logo.png" alt="Parentix" className="h-9 w-auto" />
          </Link>
          <div className="flex items-center gap-2">
            <Link to="/login" className="btn-ghost btn-sm hidden sm:inline-flex">Sign in</Link>
            <Link to="/login" className="btn-primary btn-sm">Get started</Link>
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 sm:px-6 py-10 sm:py-16">
        <div className="max-w-3xl mx-auto">
          <span className="badge-blue uppercase tracking-wide">Legal</span>
          <h1 className="text-3xl sm:text-4xl font-extrabold text-gray-900 mt-4 mb-2 tracking-tight">
            {title}
          </h1>
          <p className="text-sm text-gray-500">Last updated: {updated}</p>

          <div className="mt-10 space-y-9 text-gray-600 leading-relaxed break-words">{children}</div>
        </div>
      </main>

      <footer className="bg-gray-900 px-4 py-10 text-center pb-safe">
        <Link to="/">
          <img src="/logo.png" alt="Parentix" className="h-9 w-auto mx-auto mb-4 opacity-80" />
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
