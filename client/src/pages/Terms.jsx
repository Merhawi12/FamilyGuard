import { Link } from 'react-router-dom';

export default function Terms() {
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
            <h1 className="text-4xl font-extrabold text-gray-900 mb-3">Terms of Service</h1>
            <p className="text-gray-500 text-sm">Last updated: June 11, 2026</p>
          </div>

          <div className="prose prose-gray max-w-none space-y-10 text-gray-600 leading-relaxed">

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">1. Acceptance of Terms</h2>
              <p>
                By accessing or using FamilyGuard ("the Service"), you agree to be bound by these Terms of
                Service. If you do not agree to these terms, please do not use the Service. These terms apply
                to all users, including parents, guardians, and any other individuals who access the platform.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">2. Description of Service</h2>
              <p>
                FamilyGuard is a parental control and digital safety platform that allows parents and guardians
                to monitor and manage their children's digital activities, including screen time, app usage,
                location tracking, and web browsing — all from a single dashboard.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">3. Eligibility</h2>
              <ul className="list-disc pl-6 space-y-2">
                <li>You must be at least 18 years old to create a parent account.</li>
                <li>You must be a parent or legal guardian of the children you add to the platform.</li>
                <li>You are responsible for ensuring your use complies with applicable local laws.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">4. Account Responsibilities</h2>
              <ul className="list-disc pl-6 space-y-2">
                <li>You are responsible for maintaining the confidentiality of your account credentials.</li>
                <li>You are responsible for all activity that occurs under your account.</li>
                <li>You must notify us immediately of any unauthorized access to your account.</li>
                <li>You may not share your account with others or create accounts on behalf of third parties.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">5. Acceptable Use</h2>
              <p className="mb-3">You agree to use FamilyGuard only for lawful purposes. You may not:</p>
              <ul className="list-disc pl-6 space-y-2">
                <li>Use the Service to monitor individuals without proper legal authority (e.g., non-custodial monitoring without consent).</li>
                <li>Attempt to access, tamper with, or disrupt the Service or its servers.</li>
                <li>Use the Service to harass, abuse, or harm any individual.</li>
                <li>Reverse-engineer, decompile, or copy any part of the Service.</li>
                <li>Use the Service for any commercial surveillance purpose.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">6. Subscription & Billing</h2>
              <ul className="list-disc pl-6 space-y-2">
                <li><strong>Free Trial:</strong> New accounts receive a 7-day free trial with limited features. No credit card is required to start.</li>
                <li><strong>Paid Plans:</strong> After the trial period, continued access requires an active paid subscription (Premium at $9.99/mo or Family Plus at $14.99/mo).</li>
                <li><strong>Billing:</strong> Subscriptions are billed monthly. You may cancel at any time.</li>
                <li><strong>Refunds:</strong> We offer a 7-day money-back guarantee on first-time paid subscriptions.</li>
                <li><strong>Cancellation:</strong> Cancelling stops future charges. Access continues until the end of the current billing period.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">7. Privacy & Data</h2>
              <p>
                Your use of the Service is also governed by our{' '}
                <Link to="/privacy-policy" className="text-blue-600 hover:underline">Privacy Policy</Link>,
                which is incorporated into these Terms by reference. By using the Service, you consent to the
                collection and use of data as described in our Privacy Policy.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">8. Parental Consent & Child Monitoring</h2>
              <p>
                You represent and warrant that you have the legal right and authority to monitor the children
                added to your account. FamilyGuard is intended solely for monitoring minor children by their
                parents or legal guardians. Misuse of the Service to monitor adults or individuals without
                consent is strictly prohibited and may violate applicable laws.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">9. Intellectual Property</h2>
              <p>
                All content, features, and functionality of FamilyGuard — including but not limited to software,
                design, text, graphics, and logos — are the exclusive property of FamilyGuard and are protected
                by applicable intellectual property laws. You may not reproduce or distribute any part of the
                Service without prior written permission.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">10. Disclaimer of Warranties</h2>
              <p>
                The Service is provided "as is" and "as available" without warranties of any kind, express or
                implied. We do not warrant that the Service will be uninterrupted, error-free, or completely
                secure. FamilyGuard is a tool to assist parents — it does not guarantee complete protection
                from all online threats.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">11. Limitation of Liability</h2>
              <p>
                To the maximum extent permitted by law, FamilyGuard shall not be liable for any indirect,
                incidental, special, or consequential damages arising from your use of the Service. Our total
                liability to you shall not exceed the amount you paid us in the 12 months preceding the claim.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">12. Termination</h2>
              <p>
                We reserve the right to suspend or terminate your account at any time if you violate these
                Terms of Service. You may also delete your account at any time from your account settings.
                Upon termination, your data will be deleted in accordance with our Privacy Policy.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">13. Changes to Terms</h2>
              <p>
                We may update these Terms from time to time. We will notify you of material changes via email
                or an in-app notice. Continued use of the Service after changes take effect constitutes your
                acceptance of the revised Terms.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">14. Contact Us</h2>
              <p>If you have questions about these Terms, please contact us at:</p>
              <div className="mt-3 p-4 bg-gray-50 rounded-xl border border-gray-200 text-sm">
                <p><strong>FamilyGuard Support</strong></p>
                <p>Email: legal@familyguard.app</p>
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
