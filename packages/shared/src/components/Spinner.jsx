export default function Spinner({ label = 'Loading…', full = false }) {
  return (
    <div className={`flex items-center justify-center gap-3 text-gray-500 ${full ? 'h-screen' : 'py-10'}`}>
      <span className="w-5 h-5 rounded-full border-2 border-gray-300 border-t-blue-600 animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  );
}
