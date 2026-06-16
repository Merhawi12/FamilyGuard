import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const problems = [
  { icon: '📱', text: 'Excessive screen time' },
  { icon: '📲', text: 'Social media addiction' },
  { icon: '😰', text: 'Cyberbullying' },
  { icon: '⚠️', text: 'Online predators' },
  { icon: '🔞', text: 'Inappropriate content exposure' },
  { icon: '📍', text: 'Location and safety concerns' },
  { icon: '👁️', text: "Lack of visibility into children's digital activities" },
];

const features = [
  {
    icon: '⏱️',
    title: 'Screen Time Management',
    desc: 'Set daily limits, schedules, and device usage rules.',
  },
  {
    icon: '📲',
    title: 'App Monitoring & Control',
    desc: 'View app usage, block apps, and receive activity reports.',
  },
  {
    icon: '📍',
    title: 'Real-Time Location Tracking',
    desc: "Track children's locations with GPS and geofencing alerts.",
  },
  {
    icon: '🛡️',
    title: 'Safe Browsing Protection',
    desc: 'Block harmful websites and inappropriate content automatically.',
  },
  {
    icon: '💬',
    title: 'Social Media Monitoring',
    desc: 'Monitor activity across major social platforms and identify potential risks.',
  },
  {
    icon: '🤖',
    title: 'AI-Powered Risk Detection',
    desc: 'Detect cyberbullying, online predators, harmful content, and suspicious behavior.',
  },
  {
    icon: '🏠',
    title: 'Family Dashboard',
    desc: 'Manage all family devices from a single unified control center.',
  },
  {
    icon: '🔔',
    title: 'Instant Alerts',
    desc: 'Get notified for dangerous content, location changes, excessive screen time, and suspicious behavior.',
  },
];

const primaryCustomers = [
  { icon: '👨‍👩‍👧', label: 'Parents with children aged 5–18' },
  { icon: '💼', label: 'Working families' },
  { icon: '🏫', label: 'Schools and educational institutions' },
];

const secondaryCustomers = [
  { icon: '🏡', label: 'Childcare organizations' },
  { icon: '🧑‍⚕️', label: 'Family counselors' },
  { icon: '🏛️', label: 'Government child protection programs' },
];

const steps = [
  { step: '1', title: 'Create your account', desc: 'Sign up as a parent in under a minute.' },
  { step: '2', title: 'Add your child', desc: 'Create a child profile with their name and age.' },
  { step: '3', title: 'Link their device', desc: "Enter the 8-character code on the child's phone." },
  { step: '4', title: 'Stay in control', desc: 'Monitor, block, and protect from your dashboard.' },
];

export default function LandingPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!loading && user) navigate('/dashboard', { replace: true });
  }, [user, loading, navigate]);

  if (loading) return null;

  return (
    <div className="min-h-screen bg-white font-sans">
      {/* Navbar */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-white/90 backdrop-blur border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link to="/"><img src="/logo.png" alt="FamilyGuard" className="h-16 w-auto" /></Link>

          {/* Desktop links */}
          <div className="hidden md:flex items-center gap-4">
            <a href="#features" className="text-sm font-medium text-gray-600 hover:text-blue-600 transition">Features</a>
            <a href="#pricing" className="text-sm font-medium text-gray-600 hover:text-blue-600 transition">Pricing</a>
            <Link to="/login" className="text-sm font-medium text-gray-600 hover:text-blue-600 transition">Sign In</Link>
            <Link to="/login" className="text-sm font-medium bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition">
              Get Started Free
            </Link>
          </div>

          {/* Hamburger button */}
          <button
            className="md:hidden flex flex-col justify-center items-center w-9 h-9 gap-1.5"
            onClick={() => setMenuOpen(o => !o)}
            aria-label="Toggle menu"
          >
            <span className={`block w-6 h-0.5 bg-gray-700 transition-all duration-300 ${menuOpen ? 'rotate-45 translate-y-2' : ''}`} />
            <span className={`block w-6 h-0.5 bg-gray-700 transition-all duration-300 ${menuOpen ? 'opacity-0' : ''}`} />
            <span className={`block w-6 h-0.5 bg-gray-700 transition-all duration-300 ${menuOpen ? '-rotate-45 -translate-y-2' : ''}`} />
          </button>
        </div>

        {/* Mobile menu */}
        {menuOpen && (
          <div className="md:hidden bg-white border-t border-gray-100 px-6 py-4 flex flex-col gap-4">
            <a href="#features" onClick={() => setMenuOpen(false)} className="text-sm font-medium text-gray-700 hover:text-blue-600 transition">Features</a>
            <a href="#pricing" onClick={() => setMenuOpen(false)} className="text-sm font-medium text-gray-700 hover:text-blue-600 transition">Pricing</a>
            <Link to="/login" onClick={() => setMenuOpen(false)} className="text-sm font-medium text-gray-700 hover:text-blue-600 transition">Sign In</Link>
            <Link to="/login" onClick={() => setMenuOpen(false)} className="text-sm font-medium bg-blue-600 text-white px-4 py-3 rounded-lg hover:bg-blue-700 transition text-center">
              Get Started Free
            </Link>
          </div>
        )}
      </nav>

      {/* Hero */}
      <section className="pt-28 md:pt-32 pb-16 md:pb-24 px-4 md:px-6 bg-gradient-to-br from-blue-50 via-indigo-50 to-white">
        <div className="max-w-4xl mx-auto text-center">
          <span className="inline-block bg-blue-100 text-blue-700 text-xs font-semibold px-3 py-1 rounded-full mb-4 md:mb-6 uppercase tracking-wide">
            Parental Control & Digital Safety
          </span>
          <h1 className="text-3xl sm:text-5xl md:text-6xl font-extrabold text-gray-900 leading-tight mb-4 md:mb-6">
            Keep your family safe{' '}
            <span className="text-blue-600">online</span>
          </h1>
          <p className="text-base md:text-xl text-gray-500 max-w-2xl mx-auto mb-8 md:mb-10 leading-relaxed">
            FamilyGuard gives parents complete visibility and control over their children's digital lives —
            screen time, location, app usage, and more, all from one dashboard.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 md:gap-4 justify-center">
            <Link
              to="/login"
              className="bg-blue-600 text-white px-6 md:px-8 py-3 md:py-4 rounded-xl font-semibold text-base md:text-lg hover:bg-blue-700 transition shadow-lg shadow-blue-200"
            >
              Start for Free
            </Link>
            <a
              href="#about"
              className="bg-white text-gray-700 px-6 md:px-8 py-3 md:py-4 rounded-xl font-semibold text-base md:text-lg hover:bg-gray-50 transition border border-gray-200"
            >
              Learn More
            </a>
          </div>
          <p className="text-sm text-gray-400 mt-4 md:mt-6">No credit card required</p>
        </div>

        {/* Dashboard preview */}
        <div className="max-w-5xl mx-auto mt-10 md:mt-16">
          <div className="bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden">
            <div className="bg-gray-50 border-b border-gray-100 px-4 py-3 flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-red-400" />
              <div className="w-3 h-3 rounded-full bg-yellow-400" />
              <div className="w-3 h-3 rounded-full bg-green-400" />
              <span className="ml-4 text-xs text-gray-400 font-mono truncate">familyguard.app/dashboard</span>
            </div>
            <div className="p-4 md:p-8 grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
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
            <div className="px-4 md:px-8 pb-4 md:pb-8 grid grid-cols-1 md:grid-cols-2 gap-4">
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

      {/* About */}
      <section id="about" className="py-14 md:py-24 px-4 md:px-6 bg-white">
        <div className="max-w-4xl mx-auto text-center">
          <span className="inline-block bg-blue-100 text-blue-700 text-xs font-semibold px-3 py-1 rounded-full mb-4 uppercase tracking-wide">
            About FamilyGuard
          </span>
          <h2 className="text-4xl font-bold text-gray-900 mb-6">
            One platform. Complete family protection.
          </h2>
          <p className="text-lg text-gray-500 leading-relaxed mb-8">
            FamilyGuard is a parental control and digital safety platform that gives parents complete visibility
            and control over their children's digital lives from a single, easy-to-use dashboard.
          </p>
          <p className="text-lg text-gray-500 leading-relaxed">
            As children spend more time online, parents struggle to monitor screen time, social media usage,
            online safety, location, and digital habits. FamilyGuard solves this problem by providing
            real-time monitoring, intelligent alerts, and powerful parental controls across smartphones,
            tablets, and computers.
          </p>
        </div>
      </section>

      {/* The Problem */}
      <section className="py-14 md:py-24 px-4 md:px-6 bg-red-50">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <span className="inline-block bg-red-100 text-red-600 text-xs font-semibold px-3 py-1 rounded-full mb-4 uppercase tracking-wide">
              The Problem
            </span>
            <h2 className="text-4xl font-bold text-gray-900 mb-4">Modern parents face growing challenges</h2>
            <p className="text-lg text-gray-500 max-w-2xl mx-auto">
              Most parents use multiple apps to manage these issues, creating complexity and dangerous gaps in protection.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-10">
            {problems.map(({ icon, text }) => (
              <div key={text} className="flex items-center gap-4 bg-white rounded-xl p-5 shadow-sm border border-red-100">
                <span className="text-3xl">{icon}</span>
                <p className="text-gray-700 font-medium">{text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* The Solution */}
      <section className="py-14 md:py-24 px-4 md:px-6 bg-gradient-to-br from-blue-600 to-indigo-700">
        <div className="max-w-4xl mx-auto text-center">
          <span className="inline-block bg-white/20 text-white text-xs font-semibold px-3 py-1 rounded-full mb-4 uppercase tracking-wide">
            The Solution
          </span>
          <h2 className="text-4xl font-bold text-white mb-6">
            Everything in one place
          </h2>
          <p className="text-xl text-blue-100 leading-relaxed mb-10">
            FamilyGuard combines all essential parental control and child safety tools into one platform —
            replacing the patchwork of separate apps with a single, unified solution that leaves no gaps in protection.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 text-left">
            {[
              { icon: '🔒', title: 'Complete Protection', desc: 'Every device, every app, every platform — monitored from one dashboard.' },
              { icon: '⚡', title: 'Real-Time Response', desc: 'Instant alerts and controls so you can act the moment something needs attention.' },
              { icon: '🧠', title: 'Intelligent Detection', desc: 'AI-powered analysis identifies risks before they become serious threats.' },
            ].map(({ icon, title, desc }) => (
              <div key={title} className="bg-white/10 rounded-2xl p-6 border border-white/20">
                <div className="text-3xl mb-3">{icon}</div>
                <h3 className="text-white font-semibold text-lg mb-2">{title}</h3>
                <p className="text-blue-100 text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Core Features */}
      <section id="features" className="py-14 md:py-24 px-4 md:px-6 bg-white">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <span className="inline-block bg-blue-100 text-blue-700 text-xs font-semibold px-3 py-1 rounded-full mb-4 uppercase tracking-wide">
              Core Features
            </span>
            <h2 className="text-4xl font-bold text-gray-900 mb-4">Everything you need to protect your family</h2>
            <p className="text-lg text-gray-500 max-w-2xl mx-auto">
              Powerful tools designed for modern parents managing their children's digital wellbeing.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
            {features.map(({ icon, title, desc }) => (
              <div
                key={title}
                className="group p-6 rounded-2xl border border-gray-100 hover:border-blue-200 hover:shadow-lg transition-all"
              >
                <div className="text-4xl mb-4">{icon}</div>
                <h3 className="text-base font-semibold text-gray-900 mb-2">{title}</h3>
                <p className="text-gray-500 text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Target Market */}
      <section className="py-14 md:py-24 px-4 md:px-6 bg-gradient-to-br from-gray-50 to-blue-50">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <span className="inline-block bg-blue-100 text-blue-700 text-xs font-semibold px-3 py-1 rounded-full mb-4 uppercase tracking-wide">
              Target Market
            </span>
            <h2 className="text-4xl font-bold text-gray-900 mb-4">Built for families and institutions</h2>
            <p className="text-lg text-gray-500 max-w-2xl mx-auto">
              FamilyGuard serves anyone responsible for the digital safety of children.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
            <div className="bg-white rounded-2xl p-8 shadow-sm border border-gray-100">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold">1</div>
                <h3 className="text-xl font-bold text-gray-900">Primary Customers</h3>
              </div>
              <ul className="space-y-4">
                {primaryCustomers.map(({ icon, label }) => (
                  <li key={label} className="flex items-center gap-4">
                    <span className="text-2xl">{icon}</span>
                    <span className="text-gray-700 font-medium">{label}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="bg-white rounded-2xl p-8 shadow-sm border border-gray-100">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 font-bold">2</div>
                <h3 className="text-xl font-bold text-gray-900">Secondary Customers</h3>
              </div>
              <ul className="space-y-4">
                {secondaryCustomers.map(({ icon, label }) => (
                  <li key={label} className="flex items-center gap-4">
                    <span className="text-2xl">{icon}</span>
                    <span className="text-gray-700 font-medium">{label}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-14 md:py-24 px-4 md:px-6 bg-gray-50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-6">
            <span className="inline-block bg-blue-100 text-blue-700 text-xs font-semibold px-3 py-1 rounded-full mb-4 uppercase tracking-wide">
              Pricing
            </span>
            <h2 className="text-4xl font-bold text-gray-900 mb-4">Simple, Transparent Pricing</h2>
            <p className="text-lg text-gray-500 max-w-2xl mx-auto mb-3">
              Start free and upgrade when you're ready. No hidden fees. No contracts. No surprises.
            </p>
            <p className="text-gray-500 max-w-2xl mx-auto">
              FamilyGuard is designed to grow with your family. Whether you're protecting one child or managing
              multiple devices, you'll only pay for what you need.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 items-stretch mt-14">
            {/* Free Plan */}
            <div className="rounded-2xl border border-gray-200 bg-white p-8 flex flex-col shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-xl font-bold text-gray-900">Free Plan</h3>
                <span className="bg-yellow-100 text-yellow-700 text-xs font-semibold px-2 py-1 rounded-full">7 days only</span>
              </div>
              <p className="text-sm text-gray-500 mt-1 mb-1">Perfect for parents who want to get started.</p>
              <div className="my-5">
                <span className="text-4xl font-extrabold text-blue-600">$0</span>
                <span className="text-gray-500 text-sm">/7 days</span>
              </div>
              <ul className="space-y-3 mb-4 flex-1">
                {[
                  'Basic screen time monitoring',
                  'Daily activity reports',
                  '1 child device',
                  'Basic parental controls',
                  'Email support',
                ].map(f => (
                  <li key={f} className="flex items-start gap-2 text-gray-600 text-sm">
                    <span className="text-blue-500 font-bold mt-0.5">✔</span> {f}
                  </li>
                ))}
                <li className="flex items-center gap-2 text-yellow-600 text-sm font-medium pt-1">
                  <span>⚠️</span> Trial expires after 7 days
                </li>
              </ul>
              <Link
                to="/login"
                className="block text-center bg-blue-600 text-white py-3 rounded-xl font-semibold hover:bg-blue-700 transition"
              >
                Start Free
              </Link>
            </div>

            {/* Premium Plan */}
            <div className="relative rounded-2xl border-2 border-blue-500 bg-white p-8 flex flex-col shadow-xl">
              <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                <span className="bg-blue-600 text-white text-xs font-bold px-4 py-1.5 rounded-full shadow">Most Popular</span>
              </div>
              <div className="mb-1">
                <h3 className="text-xl font-bold text-gray-900">Premium Plan</h3>
                <p className="text-sm text-gray-500 mt-1">Everything parents need for complete digital protection.</p>
              </div>
              <div className="my-5">
                <span className="text-4xl font-extrabold text-blue-600">$9.99</span>
                <span className="text-gray-500 text-sm">/mo</span>
              </div>
              <ul className="space-y-3 mb-8 flex-1">
                {[
                  'Everything in Free',
                  'Real-time GPS tracking',
                  'Geofencing alerts',
                  'App usage monitoring',
                  'Website filtering & blocking',
                  'Screen time scheduling',
                  'Up to 5 child devices',
                  'Priority support',
                ].map(f => (
                  <li key={f} className="flex items-start gap-2 text-gray-600 text-sm">
                    <span className="text-blue-500 font-bold mt-0.5">✔</span> {f}
                  </li>
                ))}
              </ul>
              <Link
                to="/login?redirect=premium"
                className="block text-center bg-blue-600 text-white py-3 rounded-xl font-semibold hover:bg-blue-700 transition"
              >
                Get Premium
              </Link>
            </div>

            {/* Family Plus */}
            <div className="rounded-2xl border border-gray-200 bg-white p-8 flex flex-col shadow-sm hover:shadow-md transition-shadow">
              <div className="mb-1">
                <h3 className="text-xl font-bold text-gray-900">Family Plus</h3>
                <p className="text-sm text-gray-500 mt-1">Advanced protection for larger families.</p>
              </div>
              <div className="my-5">
                <span className="text-4xl font-extrabold text-blue-600">$14.99</span>
                <span className="text-gray-500 text-sm">/mo</span>
              </div>
              <ul className="space-y-3 mb-8 flex-1">
                {[
                  'Everything in Premium',
                  'Unlimited child devices',
                  'AI-powered safety alerts',
                  'Social media monitoring',
                  'Cyberbullying detection',
                  'Advanced family reports',
                  'Instant emergency notifications',
                  'Premium support',
                ].map(f => (
                  <li key={f} className="flex items-start gap-2 text-gray-600 text-sm">
                    <span className="text-blue-500 font-bold mt-0.5">✔</span> {f}
                  </li>
                ))}
              </ul>
              <Link
                to="/login?redirect=family"
                className="block text-center bg-blue-600 text-white py-3 rounded-xl font-semibold hover:bg-blue-700 transition"
              >
                Get Family Plus
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="py-14 md:py-24 px-4 md:px-6 bg-white">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-16">
            <span className="inline-block bg-blue-100 text-blue-700 text-xs font-semibold px-3 py-1 rounded-full mb-4 uppercase tracking-wide">
              How It Works
            </span>
            <h2 className="text-4xl font-bold text-gray-900 mb-4">Up and running in minutes</h2>
            <p className="text-lg text-gray-500">No technical knowledge required.</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8">
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
      <section className="py-14 md:py-24 px-4 md:px-6 bg-blue-600">
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
        <Link to="/"><img src="/logo.png" alt="FamilyGuard" className="h-10 w-auto mx-auto mb-4 opacity-80" /></Link>
        <div className="flex justify-center gap-6 mb-4">
          <Link to="/privacy-policy" className="text-gray-400 hover:text-white text-sm transition">Privacy Policy</Link>
          <Link to="/terms" className="text-gray-400 hover:text-white text-sm transition">Terms of Service</Link>
        </div>
        <p className="text-gray-400 text-sm">
          &copy; {new Date().getFullYear()} FamilyGuard. Parental Control & Digital Safety.
        </p>
      </footer>
    </div>
  );
}
