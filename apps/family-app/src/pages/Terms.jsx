import { Link } from 'react-router-dom';
import LegalPage from '../components/LegalPage';

export default function Terms() {
  return (
    <LegalPage title="Terms of Service" updated="June 11, 2026">
            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">1. Acceptance of Terms</h2>
              <p>
                By accessing or using Parentix ("the Service"), you agree to be bound by these Terms of
                Service. If you do not agree to these terms, please do not use the Service. These terms apply
                to all users, including parents, guardians, and any other individuals who access the platform.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">2. Description of Service</h2>
              <p>
                Parentix is a parental control and digital safety platform that allows parents and guardians
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
              <p className="mb-3">You agree to use Parentix only for lawful purposes. You may not:</p>
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
                <li><strong>Paid Plans:</strong> After the trial period, continued access requires an active paid subscription (Premium at $9.99/mo).</li>
                <li><strong>Legacy Plans:</strong> Family Plus is no longer sold. Existing Family Plus subscribers keep their current price and receive all Premium features until they change or cancel their plan.</li>
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
                added to your account. Parentix is intended solely for monitoring minor children by their
                parents or legal guardians. Misuse of the Service to monitor adults or individuals without
                consent is strictly prohibited and may violate applicable laws.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">9. Intellectual Property</h2>
              <p>
                All content, features, and functionality of Parentix — including but not limited to software,
                design, text, graphics, and logos — are the exclusive property of Parentix and are protected
                by applicable intellectual property laws. You may not reproduce or distribute any part of the
                Service without prior written permission.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">10. Disclaimer of Warranties</h2>
              <p>
                The Service is provided "as is" and "as available" without warranties of any kind, express or
                implied. We do not warrant that the Service will be uninterrupted, error-free, or completely
                secure. Parentix is a tool to assist parents — it does not guarantee complete protection
                from all online threats.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">11. Limitation of Liability</h2>
              <p>
                To the maximum extent permitted by law, Parentix shall not be liable for any indirect,
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
                <p><strong>Parentix Support</strong></p>
                <p>Email: legal@parentix.ca</p>
              </div>
            </section>
    </LegalPage>
  );
}
