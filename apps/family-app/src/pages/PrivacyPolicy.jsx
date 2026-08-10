import LegalPage from '../components/LegalPage';

export default function PrivacyPolicy() {
  return (
    <LegalPage title="Privacy Policy" updated="June 11, 2026">
            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">1. Introduction</h2>
              <p>
                Parentix ("we", "our", or "us") is committed to protecting the privacy of parents and children
                who use our platform. This Privacy Policy explains how we collect, use, disclose, and safeguard
                your information when you use our parental control and digital safety services.
              </p>
              <p className="mt-3">
                By using Parentix, you agree to the collection and use of information in accordance with this policy.
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
                <li>To provide, operate, and maintain the Parentix platform.</li>
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
                Parentix is designed for use by parents to monitor their minor children. We do not knowingly
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
                by email or through a notice on our platform. Continued use of Parentix after changes
                constitutes acceptance of the updated policy.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">11. Contact Us</h2>
              <p>If you have questions about this Privacy Policy, please contact us at:</p>
              <div className="mt-3 p-4 bg-gray-50 rounded-xl border border-gray-200 text-sm">
                <p><strong>Parentix Support</strong></p>
                <p>Email: privacy@parentix.ca</p>
              </div>
            </section>
    </LegalPage>
  );
}
