export default function DeviceCard({ device, onRemove }) {
  const isOnline = device.lastSeen && (Date.now() - new Date(device.lastSeen)) < 5 * 60 * 1000;

  return (
    <div className="card flex items-center gap-4">
      <div className="w-10 h-10 bg-gray-100 rounded-xl flex items-center justify-center text-xl">
        {device.type === 'android' ? '📱' : device.type === 'ios' ? '🍎' : '💻'}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{device.name}</p>
        <p className="text-sm text-gray-400">{device.child?.name} · {device.osVersion || device.type}</p>
      </div>
      <div className="flex items-center gap-3">
        <span className={`w-2 h-2 rounded-full ${isOnline ? 'bg-green-500' : 'bg-gray-300'}`} title={isOnline ? 'Online' : 'Offline'} />
        <button onClick={() => onRemove(device.id)} className="text-red-400 hover:text-red-600 text-sm transition">Remove</button>
      </div>
    </div>
  );
}
