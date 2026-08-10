import { Icon } from '@parentix/shared';

const DEVICE_ICON = { android: 'phone', ios: 'phone', windows: 'laptop', mac: 'laptop' };

const lastSeenLabel = (lastSeen) => {
  if (!lastSeen) return 'Never connected';
  const minutes = Math.round((Date.now() - new Date(lastSeen)) / 60000);
  if (minutes < 5) return 'Online now';
  if (minutes < 60) return `Last seen ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last seen ${hours}h ago`;
  return `Last seen ${new Date(lastSeen).toLocaleDateString()}`;
};

/**
 * A linked device.
 *
 * The subtitle used to read `device.child?.name` — a field the Children page
 * never loads, because it fetches devices nested inside each child rather than
 * the other way round. It rendered as a bare separator with nothing before it.
 * When the device was last heard from is what a parent actually needs here, and
 * it is always present.
 *
 * A device that was never confirmed is a different thing from one that is
 * merely offline: it holds no credential and has never reported. It gets a
 * "Connect" action so the half-finished link can be completed, rather than
 * sitting as a dead row whose only exit is the bin.
 */
export default function DeviceCard({ device, onRemove, onConnect, onEdit }) {
  const isOnline = device.lastSeen && Date.now() - new Date(device.lastSeen) < 5 * 60 * 1000;
  const isPending = !device.isLinked;

  return (
    <div className="card p-3 sm:p-4 flex items-center gap-3">
      <span className="w-11 h-11 bg-gray-50 text-gray-500 rounded-xl flex items-center justify-center shrink-0">
        <Icon name={DEVICE_ICON[device.type] || 'phone'} size={20} />
      </span>

      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm text-gray-900 truncate">{device.name}</p>
        <p className="text-xs text-gray-500 flex items-center gap-1.5 mt-0.5">
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              isOnline ? 'bg-success' : isPending ? 'bg-warning' : 'bg-gray-300'
            }`}
          />
          <span className="truncate">
            {isPending ? 'Waiting to be connected' : lastSeenLabel(device.lastSeen)}
            {device.osVersion ? ` · ${device.osVersion}` : ''}
          </span>
        </p>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {isPending && (
          <button
            onClick={() => onConnect(device)}
            className="btn-secondary btn-sm px-3 border-primary-200 text-primary-600 hover:bg-primary-50"
            aria-label={`Connect ${device.name}`}
          >
            <Icon name="qr" size={15} />
            {/* Three controls plus a name is too much for a narrow row, so the
                label drops below `sm` and the aria-label carries the meaning. */}
            <span className="hidden sm:inline">Connect</span>
          </button>
        )}
        <button
          onClick={() => onEdit(device)}
          className="icon-btn text-gray-400 hover:text-primary-600 hover:bg-primary-50"
          aria-label={`Edit ${device.name}`}
        >
          <Icon name="edit" size={17} />
        </button>
        <button
          onClick={() => onRemove(device.id, device.name)}
          className="icon-btn text-gray-400 hover:text-danger hover:bg-red-50"
          aria-label={`Remove ${device.name}`}
        >
          <Icon name="trash" size={18} />
        </button>
      </div>
    </div>
  );
}
