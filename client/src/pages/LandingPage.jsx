import { useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const features = [
  {
    icon: '⏱️',
    title: 'Screen Time Control',
    desc: 'Set daily limits, bedtime locks, and per-day schedules. Get alerts when limits are reached.',
  },
  {
    icon: '📍',
    title: 'Real-Time Location',
    desc: 'See where your child is at any moment. Get instant alerts when they enter or leave safe zones.',
  },
  {
    icon: '🚫',
    title: 'App & Website Blocking',
    desc: 'Block specific apps and websites instantly. Category-based filtering keeps harmful content away.',
  },
  {
    icon: '📊',
    title: 'Activity Monitoring',
    desc: 'Full visibility into app usage, browsing history, and device activity — all in one dashboard.',
  },
  {
    icon: '🔔',
    title: 'Instant Alerts',
    desc: 'Get notified the moment something needs your attention — blocked content, location changes, and more.',
  },
  {
    icon: '📈',
    title: 'Weekly Reports',
    desc: 'Receive a detailed weekly email summary of your child\'s digital activity and screen habits.',
  },
];

const steps = [
  { step: '1', title: 'Create your account', desc: 'Sign up as a parent in under a minute.' },
  { step: '2', title: 'Add your child', desc: 'Create a child profile with their name and age.' },
  { step: '3', title: 'Link their device', desc: 'Enter the 8-character code on the child\'s phone.' },
  { step: '4', title: 'Stay in control', desc: 'Monitor, block, and protect from your dashboard.' },
];

export default function LandingPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && user) navigate('/dashboard', { replace: true });
  }, [user, loading, navigate]);

  if (loading) return null;

  return (
    <div className="min-h-screen bg-white font-sans">
      {/* Navbar */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-white/90 backdrop-blur border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <img src="/logo.png" alt="FamilyGuard" className="h-10 w-auto" />
          <div className="flex items-center gap-4">
            <Link to="/login" className="text-sm font-medium text-gray-600 hover:text-blue-600 transition">
              Sign In
            </Link>
            <Link
              to="/login"
              className="text-sm font-medium bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition"
            >
              Get Started Free
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-32 pb-24 px-6 bg-gradient-to-br from-blue-50 via-indigo-50 to-white">
        <div className="max-w-4xl mx-auto text-center">
          <span className="inline-block bg-blue-100 text-blue-700 text-xs font-semibold px-3 py-1 rounded-full mb-6 uppercase tracking-wide">
            Parental Control & Digital Safety
          </span>
          <h1 className="text-5xl md:text-6xl font-extrabold text-gray-900 leading-tight mb-6">
            Keep your family safe{' '}
            <span className="text-blue-600">online</span>
          </h1>
          <p className="text-xl text-gray-500 max-w-2xl mx-auto mb-10 leading-relaxed">
            FamilyGuard gives parents complete visibility and control over their children's digital lives —
            screen time, location, app usage, and more, all from one dashboard.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              to="/login"
              className="bg-blue-600 text-white px-8 py-4 rounded-xl font-semibold text-lg hover:bg-blue-700 transition shadow-lg shadow-blue-200"
            >
              Start for Free
            </Link>
            <a
              href="#features"
              className="bg-white text-gray-700 px-8 py-4 rounded-xl font-semibold text-lg hover:bg-gray-50 transition border border-gray-200"
            >
              See Features
            </a>
          </div>
          <p className="text-sm text-gray-400 mt-6">No credit card required</p>
        </div>

        {/* Dashboard preview */}
        <div className="max-w-5xl mx-auto mt-16">
          <div className="bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden">
            <div className="bg-gray-50 border-b border-gray-100 px-4 py-3 flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-red-400" />
              <div className="w-3 h-3 rounded-full bg-yellow-400" />
              <div className="w-3 h-3 rounded-full bg-green-400" />
              <span className="ml-4 text-xs text-gray-400 font-mono">familyguard.app/dashboard</span>
            </div>
            <div className="p-8 grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: 'Active Devices', value: '3', color: 'blue' },
                { label: 'Screen Time Today', value: '2h 14m', color: 'indigo' },
                { label: 'Sites Blocked', value: '47', color: 'red' },
                { label: 'Alerts Today', value: '2', color: 'yellow' },
              ].map(({ label, value, color }) => (
                <div key={label} className={`bg-${color}-50 rounded-xl p-4 text-center`}>
                  <p className={`text-2xl font-bold text-${color}-600`}>{value}</p>
                  <p className="text-xs text-gray-500 mt-1">{label}</p>
                </div>
              ))}
            </div>
            <div className="px-8 pb-8 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-gray-50 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-400 uppercase mb-3">Recent Activity</p>
                {[
                  { icon: '🚫', text: 'Blocked: social-media-site.com', time: '2m ago' },
                  { icon: '📍', text: 'Salem arrived at School', time: '8m ago' },
                  { icon: '⏱️', text: 'Screen time limit reached', time: '1h ago' },
                ].map(({ icon, text, time }) => (
                  <div key={text} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                    <span className="text-sm text-gray-700">{icon} {text}</span>
                    <span className="text-xs text-gray-400">{time}</span>
                  </div>
                ))}
              </div>
              <div className="bg-gray-50 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-400 uppercase mb-3">Children</p>
                {[
                  { name: 'Salem', age: 12, status: 'At School', color: 'green' },
                  { name: 'Liya', age: 9, status: 'At Home', color: 'blue' },
                ].map(({ name, age, status, color }) => (
                  <div key={name} className="flex items-center gap-3 py-2 border-b border-gray-100 last:border-0">
                    <div className={`w-8 h-8 rounded-full bg-${color}-100 flex items-center justify-center text-${color}-600 font-bold text-sm`}>
                      {name[0]}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-800">{name}, {age}</p>
                      <p className={`text-xs text-${color}-600`}>{status}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-24 px-6 bg-white">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold text-gray-900 mb-4">Everything you need to protect your family</h2>
            <p className="text-lg text-gray-500 max-w-2xl mx-auto">
              Powerful tools designed for modern parents managing their children's digital wellbeing.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {features.map(({ icon, title, desc }) => (
              <div
                key={title}
                className="group p-6 rounded-2xl border border-gray-100 hover:border-blue-200 hover:shadow-lg transition-all"
              >
                <div className="text-4xl mb-4">{icon}</div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">{title}</h3>
                <p className="text-gray-500 text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="py-24 px-6 bg-gradient-to-br from-blue-50 to-indigo-50">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold text-gray-900 mb-4">Up and running in minutes</h2>
            <p className="text-lg text-gray-500">No technical knowledge required.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
            {steps.map(({ step, title, desc }) => (
              <div key={step} className="text-center">
                <div className="w-12 h-12 rounded-full bg-blue-600 text-white font-bold text-xl flex items-center justify-center mx-auto mb-4">
                  {step}
                </div>
                <h3 className="font-semibold text-gray-900 mb-2">{title}</h3>
                <p className="text-sm text-gray-500">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 px-6 bg-blue-600">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-4xl font-bold text-white mb-4">Start protecting your family today</h2>
          <p className="text-blue-100 text-lg mb-8">
            Join thousands of parents using FamilyGuard to keep their children safe online.
          </p>
          <Link
            to="/login"
            className="inline-block bg-white text-blue-600 px-10 py-4 rounded-xl font-bold text-lg hover:bg-blue-50 transition shadow-lg"
          >
            Create Free Account
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-10 px-6 bg-gray-900 text-center">
        <img src="/logo.png" alt="FamilyGuard" className="h-10 w-auto mx-auto mb-4 opacity-80" />
        <p className="text-gray-400 text-sm">
          &copy; {new Date().getFullYear()} FamilyGuard. Parental Control & Digital Safety.
        </p>
      </footer>
    </div>
  );
}
