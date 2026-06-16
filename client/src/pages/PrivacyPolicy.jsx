import { Link } from 'react-router-dom';

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-white font-sans">
      {/* Navbar */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-white/90 backdrop-blur border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link to="/"><img src="/logo.png" alt="FamilyGuard" className="h-16 w-auto" /></Link>
          <div className="flex items-center gap-4">
            <Link to="/login" className="text-sm font-medium text-gray-600 hover:text-blue-600 transition">Sign In</Link>
            <Link to="/login" className="text-sm font-medium bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition">
              Get Started Free
            </Link>
          </div>
        </div>
      </nav>

      {/* Content */}
      <div className="pt-28 md:pt-36 pb-16 md:pb-24 px-4 md:px-6">
        <div className="max-w-3xl mx-auto">
          <div className="mb-10">
            <span className="inline-block bg-blue-100 text-blue-700 text-xs font-semibold px-3 py-1 rounded-full mb-4 uppercase tracking-wide">
              Legal
            </span>
            <h1 className="text-4xl font-extrabold text-gray-900 mb-3">Privacy Policy</h1>
            <p className="text-gray-500 text-sm">Last updated: June 11, 2026</p>
          </div>

          <div className="prose prose-gray max-w-none space-y-10 text-gray-600 leading-relaxed">

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">1. Introduction</h2>
              <p>
                FamilyGuard ("we", "our", or "us") is committed to protecting the privacy of parents and children
                who use our platform. This Privacy Policy explains how we collect, use, disclose, and safeguard
                your information when you use our parental control and digital safety services.
              </p>
              <p className="mt-3">
                By using FamilyGuard, you agree to the collection and use of information in accordance with this policy.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">2. Information We Collect</h2>
              <p className="mb-3">We collect the following types of information:</p>
              <ul className="list-disc pl-6 space-y-2">
                <li><strong>Account Information:</strong> Name, email address, and password when you register.</li>
                <li><strong>Child Profiles:</strong> Name, age, and device identifiers for children added to your account.</li>
                <li><strong>Device Data:</strong> App usage, screen time, browsing activity, and device location from linked child devices.</li>
                <li><strong>Location Data:</strong> GPS coordinates from child devices when location tracking is enabled.</li>
                <li><strong>Usage Data:</strong> How you interact with our dashboard, features used, and session information.</li>
                <li><strong>Communications:</strong> Messages you send to our support team.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">3. How We Use Your Information</h2>
              <ul className="list-disc pl-6 space-y-2">
                <li>To provide, operate, and maintain the FamilyGuard platform.</li>
                <li>To send you alerts, notifications, and activity reports.</li>
                <li>To improve and personalize your experience.</li>
                <li>To process subscriptions and manage billing.</li>
                <li>To respond to support requests and troubleshoot issues.</li>
                <li>To comply with legal obligations and enforce our Terms of Service.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">4. Children's Privacy</h2>
              <p>
                FamilyGuard is designed for use by parents to monitor their minor children. We do not knowingly
                collect personal information directly from children under 13 without verifiable parental consent.
                All child data is collected through the parent's account and is accessible only to that parent.
              </p>
              <p className="mt-3">
                We comply with the Children's Online Privacy Protection Act (COPPA) and similar regulations.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">5. Data Sharing & Disclosure</h2>
              <p className="mb-3">We do not sell your personal data. We may share information only in the following cases:</p>
              <ul className="list-disc pl-6 space-y-2">
                <li><strong>Service Providers:</strong> Trusted third parties who help us operate our platform (e.g., cloud hosting, email delivery).</li>
                <li><strong>Legal Requirements:</strong> When required by law, court order, or to protect the safety of users.</li>
                <li><strong>Business Transfers:</strong> In the event of a merger, acquisition, or sale of assets.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">6. Data Security</h2>
              <p>
                We implement industry-standard security measures including encryption in transit (HTTPS), hashed
                passwords, and access controls to protect your data. However, no method of transmission over the
                internet is 100% secure, and we cannot guarantee absolute security.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">7. Data Retention</h2>
              <p>
                We retain your account data for as long as your account is active. Activity logs and location
                history are retained for up to 90 days by default. You may request deletion of your data at any
                time by contacting us.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">8. Your Rights</h2>
              <ul className="list-disc pl-6 space-y-2">
                <li>Access and download your personal data.</li>
                <li>Correct inaccurate information in your account.</li>
                <li>Request deletion of your account and associated data.</li>
                <li>Opt out of non-essential communications.</li>
                <li>Withdraw consent for location tracking at any time.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">9. Cookies</h2>
              <p>
                We use cookies and similar tracking technologies to maintain your session and improve platform
                performance. You can control cookie settings through your browser, though disabling cookies may
                affect functionality.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">10. Changes to This Policy</h2>
              <p>
                We may update this Privacy Policy from time to time. We will notify you of significant changes
                by email or through a notice on our platform. Continued use of FamilyGuard after changes
                constitutes acceptance of the updated policy.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">11. Contact Us</h2>
              <p>If you have questions about this Privacy Policy, please contact us at:</p>
              <div className="mt-3 p-4 bg-gray-50 rounded-xl border border-gray-200 text-sm">
                <p><strong>FamilyGuard Support</strong></p>
                <p>Email: privacy@familyguard.app</p>
              </div>
            </section>

          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="py-10 px-6 bg-gray-900 text-center">
        <Link to="/"><img src="/logo.png" alt="FamilyGuard" className="h-10 w-auto mx-auto mb-4 opacity-80" /></Link>
        <div className="flex justify-center gap-6 mb-4">
          <Link to="/privacy-policy" className="text-gray-400 hover:text-white text-sm transition">Privacy Policy</Link>
          <Link to="/terms" className="text-gray-400 hover:text-white text-sm transition">Terms of Service</Link>
        </div>
        <p className="text-gray-400 text-sm">&copy; {new Date().getFullYear()} FamilyGuard. Parental Control & Digital Safety.</p>
      </footer>
    </div>
  );
}
