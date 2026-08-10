import Icon from './Icon.jsx';

const COLORS = {
  blue: 'bg-blue-50 text-blue-600',
  green: 'bg-green-50 text-green-600',
  red: 'bg-red-50 text-red-600',
  amber: 'bg-amber-50 text-amber-600',
  purple: 'bg-purple-50 text-purple-600',
};

/**
 * One headline number.
 *
 * Stacked rather than side-by-side: two of these fit across a 360px screen, and
 * an icon-then-text row leaves the number roughly 120px to live in — which is
 * where a value like "1h 45m" starts wrapping mid-value.
 */
export default function StatsCard({ title, value, subtitle, icon, color = 'blue' }) {
  return (
    <div className="card p-4 sm:p-5 h-full">
      <span
        className={`inline-flex items-center justify-center w-9 h-9 rounded-xl mb-3 ${
          COLORS[color] || COLORS.blue
        }`}
      >
        <Icon name={icon} size={18} />
      </span>
      <p className="text-xs sm:text-sm text-gray-500 leading-tight truncate">{title}</p>
      <p className="text-xl sm:text-2xl font-bold text-gray-900 leading-tight mt-0.5">{value}</p>
      {subtitle && <p className="text-xs text-gray-400 mt-0.5 truncate">{subtitle}</p>}
    </div>
  );
}
