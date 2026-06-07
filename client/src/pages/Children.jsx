import { useEffect, useState } from 'react';
import { children as childrenApi, devices as devicesApi } from '../services/api';
import DeviceCard from '../components/DeviceCard';

export default function Children() {
  const [childList, setChildList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [linkData, setLinkData] = useState(null);
  const [form, setForm] = useState({ name: '', age: '' });
  const [deviceForm, setDeviceForm] = useState({ deviceName: '', type: 'android' });

  const load = () => childrenApi.list().then((r) => { setChildList(r.data); if (r.data[0]) setSelected(r.data[0]); });
  useEffect(() => { load(); }, []);

  const addChild = async (e) => {
    e.preventDefault();
    await childrenApi.create({ name: form.name, age: parseInt(form.age) || null });
    setForm({ name: '', age: '' });
    setShowForm(false);
    load();
  };

  const removeChild = async (id) => {
    if (confirm('Remove this child?')) { await childrenApi.remove(id); load(); }
  };

  const generateLink = async (e) => {
    e.preventDefault();
    const res = await devicesApi.generateLink({ childId: selected.id, ...deviceForm });
    setLinkData(res.data);
  };

  const removeDevice = async (id) => {
    await devicesApi.remove(id);
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Children</h1>
          <p className="text-gray-500 text-sm mt-1">Manage child profiles and linked devices</p>
        </div>
        <button onClick={() => setShowForm(true)} className="btn-primary">+ Add Child</button>
      </div>

      {showForm && (
        <div className="card">
          <h2 className="font-semibold mb-4">New Child Profile</h2>
          <form onSubmit={addChild} className="flex gap-3 flex-wrap">
            <input className="input max-w-xs" placeholder="Child's name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            <input className="input max-w-xs" type="number" placeholder="Age (optional)" value={form.age} onChange={(e) => setForm({ ...form, age: e.target.value })} />
            <button type="submit" className="btn-primary">Save</button>
            <button type="button" onClick={() => setShowForm(false)} className="btn-ghost">Cancel</button>
          </form>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-2">
          {childList.map((c) => (
            <div
              key={c.id}
              onClick={() => setSelected(c)}
              className={`card cursor-pointer transition ${selected?.id === c.id ? 'ring-2 ring-blue-500' : ''}`}
            >
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center text-xl font-bold text-blue-600">{c.name[0]}</div>
                <div className="flex-1">
                  <p className="font-medium">{c.name}</p>
                  <p className="text-xs text-gray-400">{c.age ? `Age ${c.age}` : 'No age'} · {c.devices?.length || 0} device(s)</p>
                </div>
                <button onClick={(e) => { e.stopPropagation(); removeChild(c.id); }} className="text-red-400 hover:text-red-600 text-xs">Remove</button>
              </div>
            </div>
          ))}
        </div>

        {selected && (
          <div className="lg:col-span-2 space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="font-semibold">{selected.name}'s Devices</h2>
              <button onClick={() => setShowLink(!showLink)} className="btn-primary text-sm">Link Device</button>
            </div>

            {showLink && (
              <div className="card">
                <h3 className="font-medium mb-3">Link a new device</h3>
                <form onSubmit={generateLink} className="space-y-3">
                  <input className="input" placeholder="Device name (e.g. Sarah's Phone)" value={deviceForm.deviceName} onChange={(e) => setDeviceForm({ ...deviceForm, deviceName: e.target.value })} required />
                  <select className="input" value={deviceForm.type} onChange={(e) => setDeviceForm({ ...deviceForm, type: e.target.value })}>
                    <option value="android">Android</option>
                    <option value="ios">iOS</option>
                    <option value="windows">Windows</option>
                    <option value="mac">Mac</option>
                  </select>
                  <button type="submit" className="btn-primary">Generate Code</button>
                </form>
                {linkData && (
                  <div className="mt-4 p-4 bg-blue-50 rounded-xl text-center">
                    <p className="text-sm text-gray-600 mb-2">Enter this code on the child's device:</p>
                    <p className="text-4xl font-mono font-bold text-blue-600 tracking-widest">{linkData.code}</p>
                    {linkData.qrCode && <img src={linkData.qrCode} alt="QR Code" className="mx-auto mt-3 w-32 h-32" />}
                    <p className="text-xs text-gray-400 mt-2">Valid for 30 minutes</p>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-3">
              {(selected.devices || []).length === 0 ? (
                <p className="text-gray-400 text-sm">No devices linked yet</p>
              ) : (
                selected.devices.map((d) => <DeviceCard key={d.id} device={d} onRemove={removeDevice} />)
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
