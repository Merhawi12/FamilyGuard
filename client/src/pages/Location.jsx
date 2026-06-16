import { useEffect, useState, useCallback, useRef } from 'react';
import { GoogleMap, useLoadScript, Marker, Circle, InfoWindow } from '@react-google-maps/api';
import api, { children as childrenApi, locations as locationsApi, safeZones as safeZonesApi } from '../services/api';
import { useSocket } from '../context/SocketContext';

const ZONE_COLORS = {
  home:   { stroke: '#3b82f6', fill: '#3b82f6' },
  school: { stroke: '#10b981', fill: '#10b981' },
  custom: { stroke: '#8b5cf6', fill: '#8b5cf6' },
};

const MAP_STYLES = [
  { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
];

const DEFAULT_CENTER = { lat: 9.0251, lng: 38.7469 }; // Addis Ababa

export default function Location() {
  const { isLoaded, loadError } = useLoadScript({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_KEY || '',
  });

  const [childList, setChildList]   = useState([]);
  const [selected, setSelected]     = useState(null);
  const [currentLoc, setCurrentLoc] = useState(null);
  const [zones, setZones]           = useState([]);
  const [loading, setLoading]       = useState(true);
  const [locLoading, setLocLoading] = useState(false);
  const [activeInfo, setActiveInfo] = useState(null); // 'child' | zone.id
  const [showZoneForm, setShowZoneForm] = useState(false);
  const [pickingOnMap, setPickingOnMap] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [simForm, setSimForm]       = useState({ address: '', lat: '', lng: '' });
  const [simGeoError, setSimGeoError] = useState('');
  const [showSimForm, setShowSimForm] = useState(false);
  const [zoneForm, setZoneForm]     = useState({
    name: '', type: 'custom', latitude: '', longitude: '',
    radiusMeters: 200, notifyOnEnter: true, notifyOnLeave: true,
  });

  const mapRef = useRef(null);
  const { socket } = useSocket();

  useEffect(() => {
    childrenApi.list().then((r) => {
      setChildList(r.data);
      if (r.data[0]) setSelected(r.data[0]);
    }).finally(() => setLoading(false));
  }, []);

  const loadLocation = useCallback((child) => {
    setLocLoading(true);
    setCurrentLoc(null);
    locationsApi.getCurrent(child.id)
      .then((r) => setCurrentLoc(r.data))
      .catch(() => setCurrentLoc(null))
      .finally(() => setLocLoading(false));
  }, []);

  const loadZones = useCallback((child) => {
    safeZonesApi.list(child.id).then((r) => setZones(r.data));
  }, []);

  useEffect(() => {
    if (!selected) return;
    loadLocation(selected);
    loadZones(selected);
  }, [selected, loadLocation, loadZones]);

  // Real-time socket location update
  useEffect(() => {
    if (!socket || !selected) return;
    const handler = (data) => {
      if (data.childId === selected.id) {
        setCurrentLoc((prev) => prev ? { ...prev, ...data } : data);
        if (mapRef.current) {
          mapRef.current.panTo({ lat: parseFloat(data.latitude), lng: parseFloat(data.longitude) });
        }
      }
    };
    socket.on('location:update', handler);
    return () => socket.off('location:update', handler);
  }, [socket, selected]);

  // Pan map when location loads
  useEffect(() => {
    if (currentLoc && mapRef.current) {
      mapRef.current.panTo({ lat: parseFloat(currentLoc.latitude), lng: parseFloat(currentLoc.longitude) });
    }
  }, [currentLoc]);

  const handleMapClick = useCallback((e) => {
    if (!pickingOnMap) return;
    const lat = e.latLng.lat().toFixed(6);
    const lng = e.latLng.lng().toFixed(6);
    setZoneForm((f) => ({ ...f, latitude: lat, longitude: lng }));
    setPickingOnMap(false);
    setShowZoneForm(true);
  }, [pickingOnMap]);

  const simulateLocation = async ({ latitude, longitude, address }) => {
    if (!selected) return;
    const deviceId = selected.devices?.[0]?.id || '00000000-0000-0000-0000-000000000001';
    setSimulating(true);
    try {
      await api.post('/locations', {
        childId: selected.id, deviceId,
        latitude: parseFloat(latitude), longitude: parseFloat(longitude),
        accuracy: 10, address: address || null,
      });
      await loadLocation(selected);
      setShowSimForm(false);
      setSimForm({ lat: '', lng: '', address: '' });
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to simulate location');
    } finally {
      setSimulating(false);
    }
  };

  const simulateFromBrowser = () => {
    if (!navigator.geolocation) return alert('Geolocation not supported by your browser');
    setSimulating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => simulateLocation({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      () => { setSimulating(false); alert('Could not get your location. Allow location access in your browser.'); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const geocodeAddress = async () => {
    if (!simForm.address.trim()) return;
    setSimGeoError('');

    if (!window.google?.maps?.Geocoder) {
      setSimGeoError('Google Maps not loaded yet. Check your API key in client/.env');
      return;
    }

    setSimulating(true);
    const geocoder = new window.google.maps.Geocoder();
    geocoder.geocode({ address: simForm.address.trim() }, (results, status) => {
      setSimulating(false);
      if (status === 'OK' && results?.[0]) {
        const loc = results[0].geometry.location;
        simulateLocation({
          latitude: loc.lat(),
          longitude: loc.lng(),
          address: results[0].formatted_address,
        });
      } else if (status === 'REQUEST_DENIED') {
        setSimGeoError('API key error: enable the Geocoding API in Google Cloud Console, then restart the client.');
      } else if (status === 'ZERO_RESULTS') {
        setSimGeoError('No results found. Try adding a city or country — e.g. "14923 72 St NW, Edmonton, Canada".');
      } else if (status === 'OVER_QUERY_LIMIT') {
        setSimGeoError('Geocoding quota exceeded. Check your Google Cloud billing.');
      } else {
        setSimGeoError(`Geocoder returned: ${status}. Try a more complete address.`);
      }
    });
  };

  const addZone = async (e) => {
    e.preventDefault();
    const r = await safeZonesApi.create({
      ...zoneForm,
      childId: selected.id,
      latitude: parseFloat(zoneForm.latitude),
      longitude: parseFloat(zoneForm.longitude),
      radiusMeters: parseInt(zoneForm.radiusMeters),
    });
    setZones((prev) => [...prev, r.data]);
    setShowZoneForm(false);
    setZoneForm({ name: '', type: 'custom', latitude: '', longitude: '', radiusMeters: 200, notifyOnEnter: true, notifyOnLeave: true });
  };

  const removeZone = async (id) => {
    await safeZonesApi.remove(id);
    setZones((prev) => prev.filter((z) => z.id !== id));
  };

  const toggleZone = async (zone) => {
    const r = await safeZonesApi.update(zone.id, { isActive: !zone.isActive });
    setZones((prev) => prev.map((z) => z.id === zone.id ? r.data : z));
  };

  const mapCenter = currentLoc
    ? { lat: parseFloat(currentLoc.latitude), lng: parseFloat(currentLoc.longitude) }
    : DEFAULT_CENTER;

  if (loading) return <div className="text-gray-400 text-sm p-4">Loading...</div>;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl md:text-2xl font-bold text-gray-900">Location</h1>
        <p className="text-gray-500 text-sm mt-1">Real-time GPS tracking and safe zones</p>
      </div>

      {childList.length === 0 ? (
        <div className="card text-center py-12">
          <span className="text-5xl">📍</span>
          <h2 className="text-lg font-semibold mt-4 mb-2">No children added yet</h2>
          <p className="text-gray-500 text-sm mb-4">Add a child and link their device to track location.</p>
          <a href="/dashboard/children" className="btn-primary inline-block px-6">Go to Children →</a>
        </div>
      ) : (
        <>
          {/* Child tabs */}
          <div className="flex gap-2 flex-wrap">
            {childList.map((c) => (
              <button key={c.id} onClick={() => setSelected(c)}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition ${
                  selected?.id === c.id ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'
                }`}>
                {c.name}
              </button>
            ))}
          </div>

          {selected && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
              {/* Map column */}
              <div className="lg:col-span-2 space-y-3">
                <div className="card p-0 overflow-hidden">
                  {/* Toolbar */}
                  <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-gray-100">
                    <div>
                      <span className="font-semibold text-sm">{selected.name}'s Location</span>
                      {locLoading && <span className="text-xs text-gray-400 ml-2">Fetching…</span>}
                      {!locLoading && currentLoc && (
                        <span className="text-xs text-gray-400 ml-2">
                          Updated {new Date(currentLoc.recordedAt || currentLoc.updatedAt).toLocaleTimeString()}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      <button
                        onClick={() => { setPickingOnMap(true); setShowZoneForm(false); }}
                        className={`text-xs px-3 py-1.5 rounded-lg border transition ${
                          pickingOnMap ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 hover:bg-gray-50'
                        }`}
                      >
                        {pickingOnMap ? '📍 Click map to place zone' : '+ Add Safe Zone'}
                      </button>
                      {pickingOnMap && (
                        <button onClick={() => setPickingOnMap(false)} className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50">
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Google Map */}
                  <div style={{ height: '420px' }}>
                    {loadError && (
                      <div className="h-full flex items-center justify-center bg-gray-50">
                        <div className="text-center">
                          <p className="text-red-500 font-medium text-sm">Failed to load Google Maps</p>
                          <p className="text-gray-400 text-xs mt-1">Check your API key in client/.env</p>
                        </div>
                      </div>
                    )}
                    {!isLoaded && !loadError && (
                      <div className="h-full flex items-center justify-center bg-gray-50">
                        <p className="text-gray-400 text-sm">Loading map…</p>
                      </div>
                    )}
                    {isLoaded && !loadError && (
                      <GoogleMap
                        mapContainerStyle={{ width: '100%', height: '100%' }}
                        center={mapCenter}
                        zoom={currentLoc ? 15 : 12}
                        onLoad={(map) => { mapRef.current = map; }}
                        onClick={handleMapClick}
                        options={{
                          styles: MAP_STYLES,
                          disableDefaultUI: false,
                          zoomControl: true,
                          streetViewControl: false,
                          mapTypeControl: false,
                          fullscreenControl: true,
                          cursor: pickingOnMap ? 'crosshair' : 'default',
                        }}
                      >
                        {/* Child marker */}
                        {currentLoc && (
                          <>
                            <Marker
                              position={{ lat: parseFloat(currentLoc.latitude), lng: parseFloat(currentLoc.longitude) }}
                              title={selected.name}
                              onClick={() => setActiveInfo('child')}
                              icon={{
                                url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`
                                  <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
                                    <circle cx="20" cy="20" r="18" fill="#3b82f6" stroke="white" stroke-width="3"/>
                                    <text x="20" y="26" text-anchor="middle" font-size="18" fill="white">${selected.name[0].toUpperCase()}</text>
                                  </svg>`)}`,
                                scaledSize: { width: 40, height: 40 },
                                anchor: { x: 20, y: 20 },
                              }}
                            />
                            {activeInfo === 'child' && (
                              <InfoWindow
                                position={{ lat: parseFloat(currentLoc.latitude), lng: parseFloat(currentLoc.longitude) }}
                                onCloseClick={() => setActiveInfo(null)}
                              >
                                <div className="text-sm min-w-[140px]">
                                  <p className="font-bold text-gray-900">{selected.name}</p>
                                  {currentLoc.address && <p className="text-gray-600 mt-1">{currentLoc.address}</p>}
                                  <p className="text-gray-400 text-xs mt-1">
                                    {parseFloat(currentLoc.latitude).toFixed(5)}, {parseFloat(currentLoc.longitude).toFixed(5)}
                                  </p>
                                  {currentLoc.accuracy && (
                                    <p className="text-gray-400 text-xs">±{Math.round(currentLoc.accuracy)}m accuracy</p>
                                  )}
                                  <p className="text-gray-400 text-xs mt-1">
                                    {new Date(currentLoc.recordedAt).toLocaleTimeString()}
                                  </p>
                                </div>
                              </InfoWindow>
                            )}
                          </>
                        )}

                        {/* Safe zone circles */}
                        {zones.filter((z) => z.isActive).map((zone) => {
                          const color = ZONE_COLORS[zone.type] || ZONE_COLORS.custom;
                          return (
                            <div key={zone.id}>
                              <Circle
                                center={{ lat: parseFloat(zone.latitude), lng: parseFloat(zone.longitude) }}
                                radius={zone.radiusMeters}
                                options={{
                                  strokeColor: color.stroke,
                                  strokeOpacity: 0.9,
                                  strokeWeight: 2,
                                  fillColor: color.fill,
                                  fillOpacity: 0.15,
                                  clickable: true,
                                }}
                                onClick={() => setActiveInfo(zone.id)}
                              />
                              {activeInfo === zone.id && (
                                <InfoWindow
                                  position={{ lat: parseFloat(zone.latitude), lng: parseFloat(zone.longitude) }}
                                  onCloseClick={() => setActiveInfo(null)}
                                >
                                  <div className="text-sm min-w-[120px]">
                                    <p className="font-bold text-gray-900">{zone.name}</p>
                                    <p className="text-gray-500 capitalize text-xs mt-0.5">{zone.type}</p>
                                    <p className="text-gray-400 text-xs">Radius: {zone.radiusMeters}m</p>
                                    <div className="flex gap-2 mt-1 text-xs text-gray-400">
                                      {zone.notifyOnEnter && <span>↓ Enter alert</span>}
                                      {zone.notifyOnLeave && <span>↑ Leave alert</span>}
                                    </div>
                                  </div>
                                </InfoWindow>
                              )}
                            </div>
                          );
                        })}
                      </GoogleMap>
                    )}
                  </div>
                </div>

                {/* Simulate location panel */}
                {!locLoading && !currentLoc && (
                  <div className="card border border-blue-100 bg-blue-50">
                    <div className="flex items-start gap-3">
                      <span className="text-2xl shrink-0">📡</span>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-blue-900 text-sm">No location data yet</p>
                        <p className="text-xs text-blue-700 mt-0.5">
                          The child's device reports location once the mobile app is running. Use the buttons below to simulate a location for testing.
                        </p>
                        <div className="flex flex-wrap gap-2 mt-3">
                          <button onClick={simulateFromBrowser} disabled={simulating}
                            className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50">
                            {simulating ? 'Getting…' : '📍 Use My Location'}
                          </button>
                          <button onClick={() => { setShowSimForm(v => !v); setSimGeoError(''); }}
                            className="text-xs px-3 py-1.5 bg-white border border-blue-200 text-blue-700 rounded-lg hover:bg-blue-50 transition">
                            🔍 Search Address
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {!locLoading && currentLoc && (
                  <div className="flex gap-2">
                    <button onClick={simulateFromBrowser} disabled={simulating}
                      className="text-xs px-3 py-1.5 bg-white border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition disabled:opacity-50">
                      {simulating ? 'Updating…' : '🔄 Use My Location'}
                    </button>
                    <button onClick={() => { setShowSimForm(v => !v); setSimGeoError(''); }}
                      className="text-xs px-3 py-1.5 bg-white border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition">
                      🔍 Search Address
                    </button>
                  </div>
                )}

                {showSimForm && (
                  <div className="card space-y-4">
                    <h3 className="font-semibold text-sm">Set Location</h3>

                    {/* Address search */}
                    <div>
                      <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Search by Address</label>
                      <div className="flex gap-2 mt-1">
                        <input
                          className="input flex-1"
                          placeholder="Enter your address"
                          value={simForm.address}
                          onChange={(e) => { setSimForm({ ...simForm, address: e.target.value }); setSimGeoError(''); }}
                          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), geocodeAddress())}
                        />
                        <button
                          type="button"
                          onClick={geocodeAddress}
                          disabled={simulating || !simForm.address.trim() || !isLoaded}
                          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-xl hover:bg-blue-700 transition disabled:opacity-50 shrink-0"
                        >
                          {simulating ? '…' : 'Go'}
                        </button>
                      </div>
                      {simGeoError && <p className="text-xs text-red-500 mt-1">{simGeoError}</p>}
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-px bg-gray-200" />
                      <span className="text-xs text-gray-400">or enter coordinates</span>
                      <div className="flex-1 h-px bg-gray-200" />
                    </div>

                    {/* Manual coordinates */}
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <input className="input" placeholder="Latitude e.g. 9.0251" type="number" step="any"
                          value={simForm.lat} onChange={(e) => setSimForm({ ...simForm, lat: e.target.value })} />
                        <input className="input" placeholder="Longitude e.g. 38.7469" type="number" step="any"
                          value={simForm.lng} onChange={(e) => setSimForm({ ...simForm, lng: e.target.value })} />
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={simulating || !simForm.lat || !simForm.lng}
                          onClick={() => simulateLocation({ latitude: simForm.lat, longitude: simForm.lng, address: simForm.address })}
                          className="btn-primary flex-1 text-sm disabled:opacity-50"
                        >
                          {simulating ? 'Posting…' : 'Post Coordinates'}
                        </button>
                        <button type="button" onClick={() => { setShowSimForm(false); setSimGeoError(''); }} className="btn-ghost flex-1 text-sm">
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Add zone form */}
                {showZoneForm && (
                  <div className="card">
                    <h3 className="font-semibold mb-3">New Safe Zone</h3>
                    <form onSubmit={addZone} className="space-y-3">
                      <input className="input" placeholder="Zone name (e.g. Home, School)" value={zoneForm.name}
                        onChange={(e) => setZoneForm({ ...zoneForm, name: e.target.value })} required />
                      <select className="input" value={zoneForm.type} onChange={(e) => setZoneForm({ ...zoneForm, type: e.target.value })}>
                        <option value="home">🏠 Home</option>
                        <option value="school">🏫 School</option>
                        <option value="custom">📍 Custom</option>
                      </select>
                      <div className="grid grid-cols-2 gap-2">
                        <input className="input" placeholder="Latitude" type="number" step="any" value={zoneForm.latitude}
                          onChange={(e) => setZoneForm({ ...zoneForm, latitude: e.target.value })} required />
                        <input className="input" placeholder="Longitude" type="number" step="any" value={zoneForm.longitude}
                          onChange={(e) => setZoneForm({ ...zoneForm, longitude: e.target.value })} required />
                      </div>
                      <div className="flex items-center gap-3">
                        <label className="text-sm text-gray-600 shrink-0">Radius (m)</label>
                        <input className="input" type="number" min="50" max="5000" value={zoneForm.radiusMeters}
                          onChange={(e) => setZoneForm({ ...zoneForm, radiusMeters: e.target.value })} />
                      </div>
                      <div className="flex flex-wrap gap-4">
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input type="checkbox" checked={zoneForm.notifyOnEnter} className="w-4 h-4 accent-blue-600"
                            onChange={(e) => setZoneForm({ ...zoneForm, notifyOnEnter: e.target.checked })} />
                          Alert on enter
                        </label>
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input type="checkbox" checked={zoneForm.notifyOnLeave} className="w-4 h-4 accent-blue-600"
                            onChange={(e) => setZoneForm({ ...zoneForm, notifyOnLeave: e.target.checked })} />
                          Alert on leave
                        </label>
                      </div>
                      <div className="flex gap-2">
                        <button type="submit" className="btn-primary flex-1">Save Zone</button>
                        <button type="button" onClick={() => setShowZoneForm(false)} className="btn-ghost flex-1">Cancel</button>
                      </div>
                    </form>
                  </div>
                )}
              </div>

              {/* Right panel */}
              <div className="space-y-4">
                {/* Current location */}
                <div className="card">
                  <h3 className="font-semibold mb-3 text-sm">Current Location</h3>
                  {locLoading ? (
                    <p className="text-gray-400 text-sm">Fetching…</p>
                  ) : currentLoc ? (
                    <div className="space-y-2 text-sm">
                      {currentLoc.address && (
                        <div>
                          <p className="text-xs text-gray-400 uppercase font-semibold mb-0.5">Address</p>
                          <p className="text-gray-800">{currentLoc.address}</p>
                        </div>
                      )}
                      <div className="grid grid-cols-2 gap-2 pt-1">
                        <div className="bg-gray-50 rounded-lg p-2 text-center">
                          <p className="text-xs text-gray-400">Lat</p>
                          <p className="font-mono text-xs">{parseFloat(currentLoc.latitude).toFixed(5)}</p>
                        </div>
                        <div className="bg-gray-50 rounded-lg p-2 text-center">
                          <p className="text-xs text-gray-400">Lng</p>
                          <p className="font-mono text-xs">{parseFloat(currentLoc.longitude).toFixed(5)}</p>
                        </div>
                      </div>
                      {currentLoc.accuracy && <p className="text-xs text-gray-400">Accuracy: ±{Math.round(currentLoc.accuracy)}m</p>}
                      {currentLoc.speed != null && <p className="text-xs text-gray-400">Speed: {(currentLoc.speed * 3.6).toFixed(1)} km/h</p>}
                      <p className="text-xs text-gray-400">{new Date(currentLoc.recordedAt || currentLoc.updatedAt).toLocaleString()}</p>
                    </div>
                  ) : (
                    <p className="text-gray-400 text-sm">No location data</p>
                  )}
                </div>

                {/* Safe Zones */}
                <div className="card">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold text-sm">Safe Zones</h3>
                    <button onClick={() => { setShowZoneForm(true); setPickingOnMap(false); }} className="text-xs text-blue-600 hover:underline">+ Add</button>
                  </div>
                  {zones.length === 0 ? (
                    <p className="text-gray-400 text-sm">No zones. Click "+ Add Safe Zone" on the map toolbar.</p>
                  ) : (
                    <div className="space-y-2">
                      {zones.map((zone) => {
                        const color = ZONE_COLORS[zone.type] || ZONE_COLORS.custom;
                        return (
                          <div key={zone.id} className={`flex items-start gap-2 p-2 rounded-xl border ${zone.isActive ? 'border-gray-100' : 'border-gray-100 opacity-50'}`}>
                            <span className="w-3 h-3 rounded-full mt-1 shrink-0" style={{ background: color.fill }} />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{zone.name}</p>
                              <p className="text-xs text-gray-400 capitalize">{zone.type} · {zone.radiusMeters}m</p>
                            </div>
                            <div className="flex flex-col gap-1 shrink-0">
                              <button onClick={() => toggleZone(zone)}
                                className={`text-xs px-2 py-0.5 rounded ${zone.isActive ? 'text-green-600 bg-green-50' : 'text-gray-400 bg-gray-100'}`}>
                                {zone.isActive ? 'On' : 'Off'}
                              </button>
                              <button onClick={() => removeZone(zone.id)} className="text-xs text-red-400 hover:text-red-600">Remove</button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Legend */}
                <div className="card">
                  <h3 className="font-semibold text-sm mb-2">Zone Legend</h3>
                  <div className="space-y-1.5">
                    {Object.entries(ZONE_COLORS).map(([type, color]) => (
                      <div key={type} className="flex items-center gap-2 text-sm text-gray-600">
                        <span className="w-3 h-3 rounded-full shrink-0" style={{ background: color.fill }} />
                        <span className="capitalize">{type}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
