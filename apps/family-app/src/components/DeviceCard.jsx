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
 *
 * Pause sits next to Remove and has to be told apart from it at a glance, since
 * one is undone with a tap and the other cannot be undone at all. So a paused
 * device says so on its status line rather than only in the button, and the
 * button keeps its own colour: amber for a state you are meant to leave, red
 * reserved for the destructive one.
 */
export default function DeviceCard({ device, onRemove, onConnect, onEdit, onToggleBlock, busy }) {
  const isOnline = device.lastSeen && Date.now() - new Date(device.lastSeen) < 5 * 60 * 1000;
  const isPending = !device.isLinked;
  const isBlocked = Boolean(device.blockedAt);

  /**
   * Paused outranks online in the status line.
   *
   * A paused device is still reporting — that is the point of the design — so it
   * would otherwise sit there reading "Online now" while the child stares at a
   * lock screen, which is true and useless. What the parent needs to see is the
   * thing they did.
   */
  const status = isBlocked
    ? { dot: 'bg-warning', text: `Paused${device.blockedAt ? ` · ${lastSeenLabel(device.lastSeen).toLowerCase()}` : ''}` }
    : {
      dot: isOnline ? 'bg-success' : isPending ? 'bg-warning' : 'bg-gray-300',
      text: isPending ? 'Waiting to be connected' : lastSeenLabel(device.lastSeen),
    };

  return (
    <div className="card p-3 sm:p-4 flex items-center gap-3">
      <span
        className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
          isBlocked ? 'bg-amber-50 text-warning' : 'bg-gray-50 text-gray-500'
        }`}
      >
        <Icon name={isBlocked ? 'lock' : DEVICE_ICON[device.type] || 'phone'} size={20} />
      </span>

      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm text-gray-900 truncate">{device.name}</p>
        <p className="text-xs text-gray-500 flex items-center gap-1.5 mt-0.5">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${status.dot}`} />
          <span className="truncate">
            {status.text}
            {device.osVersion ? ` · ${device.osVersion}` : ''}
          </span>
        </p>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {/* A device that never connected has nothing to pause: it holds no
            credential, runs no agent, and there is no screen to lock. */}
        {!isPending && onToggleBlock && (
          <button
            onClick={() => onToggleBlock(device)}
            disabled={busy}
            className={`icon-btn disabled:opacity-40 ${
              isBlocked
                ? 'text-warning hover:bg-amber-50'
                : 'text-gray-400 hover:text-warning hover:bg-amber-50'
            }`}
            aria-label={`${isBlocked ? 'Unpause' : 'Pause'} ${device.name}`}
            title={isBlocked
              ? 'Unpause this device'
              : 'Pause this device — it stays connected and keeps reporting'}
          >
            <Icon name={isBlocked ? 'lock' : 'block'} size={17} />
          </button>
        )}
        {isPending && (
          <button
            onClick={() => onConnect(device)}
            className="btn-secondary btn-sm min-w-[44px] min-h-[44px] px-3 border-primary-200
                       text-primary-600 hover:bg-primary-50"
            aria-label={`Connect ${device.name}`}
          >
            <Icon name="qr" size={15} />
            {/* Three controls plus a name is too much for a narrow row, so the
                label drops below `sm` and the aria-label carries the meaning.
                Losing the label also loses the width that made this tappable —
                it measured 41x36 on a 320px screen — so the minimums are stated
                rather than left to depend on the text that is no longer there. */}
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
