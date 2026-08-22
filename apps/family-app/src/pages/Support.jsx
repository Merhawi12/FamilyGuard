import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { contactForm, errorMessage, Icon, useAuth } from '@parentix/shared';
import PageIntro from '../components/PageIntro';

const MAX_MESSAGE = 5000;

/**
 * Contact support, inside the dashboard.
 *
 * This used to be `<a href="/contact">` — a full page navigation out of the SPA
 * onto the static marketing contact page. The session survived (the token never
 * moved) but the parent landed on a page headed "Sign in / Get Started Free"
 * with no way back into the app, which is indistinguishable from having been
 * signed out. Asking for help is the worst possible moment to do that to
 * someone.
 *
 * So support lives here instead: inside `PrivateRoute` and inside `Layout`, with
 * the sidebar and tab bar still on screen. "Return to the dashboard" is not a
 * feature this page had to add — it is simply never lost.
 *
 * The public form at `/contact.html` stays exactly as it was. It is for people
 * who do not have an account, which is a different problem from a customer with
 * a broken one.
 */
export default function Support() {
  const { user } = useAuth();
  /**
   * Prefilled from the session, and editable.
   *
   * A signed-in parent should not be retyping their own address to reach
   * support, and a typo there is a reply that never arrives. Editable because
   * the account address is not always the one someone can read today — that is
   * frequently *why* they are writing.
   */
  const [form, setForm] = useState({ name: '', email: '', message: '' });
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  /**
   * Spam controls the public form already uses, kept identical here so both
   * doors are classified the same way — see contactFormController.
   * `honeypot` is a field only a bot fills in; `renderedAt` catches a form
   * submitted impossibly fast after loading.
   */
  const [honeypot, setHoneypot] = useState('');
  const renderedAt = useRef(Date.now());

  useEffect(() => {
    if (!user) return;
    setForm((f) => ({
      ...f,
      name: f.name || user.name || '',
      email: f.email || user.email || '',
    }));
  }, [user]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSending(true);
    try {
      await contactForm.send({
        name: form.name.trim(),
        email: form.email.trim(),
        message: form.message.trim(),
        honeypot,
        renderedAt: renderedAt.current,
      });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err, 'Could not send that message. Please try again.'));
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <div className="space-y-5">
        <PageIntro description="We have your message." />
        <div className="card text-center py-10">
          <span className="w-12 h-12 rounded-2xl bg-success/10 text-success flex items-center justify-center mx-auto mb-4">
            <Icon name="check" size={24} strokeWidth={2.2} />
          </span>
          <h2 className="section-title mb-1">Message sent</h2>
          <p className="text-sm text-gray-600 max-w-sm mx-auto">
            We will reply to
            {' '}
            <span className="font-medium text-gray-900">{form.email}</span>
            . Most questions are answered within one working day.
          </p>
          <div className="flex flex-wrap gap-2 justify-center mt-6">
            <Link to="/dashboard" className="btn-primary btn-sm">Back to dashboard</Link>
            <button
              type="button"
              onClick={() => { setSent(false); setForm((f) => ({ ...f, message: '' })); renderedAt.current = Date.now(); }}
              className="btn-secondary btn-sm"
            >
              Send another
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageIntro description="Tell us what is going wrong and we will help." />

      {error && (
        <div className="card border-red-200 bg-red-50">
          <p className="text-sm text-gray-900">{error}</p>
        </div>
      )}

      <form onSubmit={submit} className="card space-y-4 max-w-2xl">
        <label className="field">
          <span className="field-label">Your name</span>
          <input
            className="input"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            maxLength={120}
          />
        </label>

        <label className="field">
          <span className="field-label">Reply to</span>
          <input
            type="email"
            className="input"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            required
          />
          <span className="text-xs text-gray-500 mt-1">
            Taken from your account. Change it if you would rather we replied somewhere else.
          </span>
        </label>

        <label className="field">
          <span className="field-label">How can we help?</span>
          <textarea
            className="input min-h-[9rem] resize-y"
            value={form.message}
            onChange={(e) => setForm({ ...form, message: e.target.value.slice(0, MAX_MESSAGE) })}
            required
            placeholder="What were you doing, and what happened instead?"
          />
          <span className="text-xs text-gray-400 mt-1">
            {form.message.length}
            /
            {MAX_MESSAGE}
          </span>
        </label>

        {/* Not display:none — a bot reading the stylesheet skips those. Off-screen
            and out of the tab order, matching the public form. */}
        <div className="absolute -left-[9999px]" aria-hidden="true">
          <label htmlFor="sp-company">Company</label>
          <input
            id="sp-company"
            name="company"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={honeypot}
            onChange={(e) => setHoneypot(e.target.value)}
          />
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          <button type="submit" className="btn-primary" disabled={sending || !form.message.trim()}>
            {sending ? 'Sending…' : 'Send message'}
          </button>
          <Link to="/dashboard/settings?section=about" className="btn-secondary">Cancel</Link>
        </div>
      </form>

      <div className="card">
        <h2 className="section-title mb-2">Before you write</h2>
        <p className="text-sm text-gray-600">
          If a child&rsquo;s device has stopped reporting, check it is still linked under
          {' '}
          <Link to="/dashboard/children" className="link-action">Children</Link>
          {' '}
          — a device that was removed has to be linked again with a new code.
        </p>
      </div>
    </div>
  );
}
