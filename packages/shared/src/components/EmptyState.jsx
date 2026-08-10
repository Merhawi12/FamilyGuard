import Icon from './Icon.jsx';

/**
 * What a screen shows when it has nothing to show.
 *
 * "No data" on its own tells a parent nothing about whether something is broken
 * or simply has not happened yet, so `description` is where the reason goes and
 * `action` is the way out of it.
 */
export default function EmptyState({ icon = 'inbox', title, description, action, compact = false }) {
  return (
    <div className={`text-center ${compact ? 'py-8' : 'py-12'} px-4`}>
      <span className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gray-50 text-gray-300 mb-4">
        <Icon name={icon} size={26} strokeWidth={1.5} />
      </span>
      <p className="font-semibold text-gray-900">{title}</p>
      {description && (
        <p className="text-sm text-gray-500 mt-1.5 max-w-xs mx-auto leading-relaxed">{description}</p>
      )}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}
