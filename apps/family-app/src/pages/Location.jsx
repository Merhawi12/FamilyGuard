import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  children as childrenApi, locations as locationsApi, safeZones as safeZonesApi,
  errorMessage, isStaff, EmptyState, Icon, Modal, Toggle, useAuth, useSocket,
} from '@parentix/shared';
import ChildTabs from '../components/ChildTabs';
import PageIntro from '../components/PageIntro';
import { PRIMARY } from '../brand';
import { mapsAuthFailed, onMapsAuthFailure } from '../services/mapsAuth';
import { geocode } from '../services/geocode';

/* The two renderers, each loaded only if it is the one that draws. They take the
   same normalised props and expose the same `panTo`, so everything else on this
   page is written once. Whichever a deployment does not use costs it nothing:
   without a key the Google wrapper is never fetched, and with one Leaflet is
   never fetched. */
const GoogleMapPane = lazy(() => import('../components/GoogleMapPane'));
const OpenMap = lazy(() => import('../components/OpenMap'));

/* Home is the brand teal because it is the zone every family has and the one
   the map is usually centred on; the other two only have to stay clearly
   distinct from it and from each other. */
const ZONE_COLORS = {
  home: PRIMARY,
  school: '#10b981',
  custom: '#8b5cf6',
};

/* Where the map looks before anything has been reported. Parentix is a Canadian
   service, so an empty map opens on Canada rather than nowhere in particular —
   but nothing here is restricted to it. A family on holiday, or a child at
   school abroad, still reports and geocodes normally. */
const DEFAULT_CENTER = { lat: 56.1304, lng: -106.3468 }; // geographic centre of Canada
const DEFAULT_ZOOM = 4; // the whole country; a reported fix overrides this with 15

const MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY || '';

const EMPTY_ZONE = {
  name: '', type: 'custom', latitude: '', longitude: '',
  radiusMeters: 200, notifyOnEnter: true, notifyOnLeave: true,
};

/* GeolocationPositionError codes. Blaming the site permission for all three
   sends a parent to a settings page that was never the problem — a desktop with
   Windows location services turned off reports POSITION_UNAVAILABLE, and there
   is nothing to allow. */
const GEO_ERRORS = {
  1: 'Location access is blocked for this site. Allow it in your browser’s site settings, then try again.',
  2: 'Your device could not work out where it is. On a computer this usually means location is switched off in the system settings — or use "Set by address" instead.',
  3: 'Working out your location took too long. Try again, or use "Set by address".',
};

const readPosition = (options) => new Promise((resolve, reject) => {
  navigator.geolocation.getCurrentPosition(resolve, reject, options);
});

/* A browser key is public, so the only thing protecting it is an allowlist of
   the hostnames that may use it — and a correctly restricted one therefore
   refuses `localhost`. Google saying no here is the *right* configuration
   working, not a fault, so the notice that calls it a fault is not shown at a
   development origin. The console line below still explains the map. */
const LOCAL_ORIGIN = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i
  .test(typeof window === 'undefined' ? '' : window.location.host);

export default function Location() {
  // Whether this deployment was built with a Maps key at all. Most are not: a
  // Maps key is a billing-backed secret someone has to create in the Cloud
  // console, and the map below has to work regardless.
  const mapsKeyMissing = !MAPS_API_KEY;

  // A key that is present and still refused — the usual cause being a referrer
  // allowlist that does not cover this host. Nothing in the loader reports it;
  // see services/mapsAuth.js.
  const [mapsRefused, setMapsRefused] = useState(mapsAuthFailed);
  useEffect(() => onMapsAuthFailure(setMapsRefused), []);

  // A script that never arrived. Google's own renderer reports it up here,
  // because the fallback belongs to the page rather than to that component.
  const [mapsLoadFailed, setMapsLoadFailed] = useState(false);
  const onMapsLoadError = useCallback(() => setMapsLoadFailed(true), []);

  // Said once, wherever the page runs, because a developer whose map is not the
  // one they configured should not have to guess why — including on localhost,
  // where the notice below is deliberately silent.
  useEffect(() => {
    if (!mapsRefused && !mapsLoadFailed) return;
    console.warn(
      mapsRefused
        ? `Google refused the Maps key for ${window.location.host}; drawing OpenStreetMap instead. `
          + 'Add this host to the key\'s referrer allowlist, or check that the Maps JavaScript API and billing are on.'
        : 'The Google Maps script did not load; drawing OpenStreetMap instead.',
    );
  }, [mapsRefused, mapsLoadFailed]);

  const [childList, setChildList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [currentLoc, setCurrentLoc] = useState(null);
  const [zones, setZones] = useState([]);
  const [zonesError, setZonesError] = useState('');
  const [loading, setLoading] = useState(true);
  const [locLoading, setLocLoading] = useState(false);
  // Distinct from "no position yet" — see loadLocation.
  const [locError, setLocError] = useState('');
  const [pickingOnMap, setPickingOnMap] = useState(false);
  const [showZoneForm, setShowZoneForm] = useState(false);
  const [zoneForm, setZoneForm] = useState(EMPTY_ZONE);
  const [showSetLocation, setShowSetLocation] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [simForm, setSimForm] = useState({ address: '', lat: '', lng: '' });
  const [error, setError] = useState('');

  const mapRef = useRef(null);
  const { socket } = useSocket();
  const { user } = useAuth();

  useEffect(() => {
    childrenApi.list()
      .then((r) => { setChildList(r.data); if (r.data[0]) setSelected(r.data[0]); })
      .catch(() => setError('Could not load your children.'))
      .finally(() => setLoading(false));
  }, []);

  const loadLocation = useCallback((child) => {
    setLocLoading(true);
    setCurrentLoc(null);
    setLocError('');
    locationsApi.getCurrent(child.id)
      .then((r) => setCurrentLoc(r.data))
      // A child who has never reported comes back as 200 with a null body, so
      // reaching here means the request itself failed. Saying "no position
      // reported yet" for that would tell a parent looking for their child that
      // there is nothing to find, which is not what happened.
      .catch((err) => setLocError(errorMessage(err, 'Could not reach the server.')))
      .finally(() => setLocLoading(false));
  }, []);

  const loadZones = useCallback((child) => {
    setZonesError('');
    return safeZonesApi.list(child.id)
      .then((r) => setZones(r.data))
      // Same distinction the current-position load draws just above: a family
      // with no geofences is a 200 with an empty list, so reaching here means
      // the request failed. Rendering that as "No safe zones" told a parent
      // their geofences were gone — and the map above drops every circle to
      // match, so the whole screen agreed with the wrong answer.
      .catch((err) => {
        setZones([]);
        setZonesError(errorMessage(err, 'Could not load your safe zones.'));
      });
  }, []);

  useEffect(() => {
    if (!selected) return;
    loadLocation(selected);
    loadZones(selected);
  }, [selected, loadLocation, loadZones]);

  // Real-time position updates.
  useEffect(() => {
    if (!socket || !selected) return undefined;
    const handler = (data) => {
      if (data.childId !== selected.id) return;
      setCurrentLoc((prev) => (prev ? { ...prev, ...data } : data));
      mapRef.current?.panTo({ lat: parseFloat(data.latitude), lng: parseFloat(data.longitude) });
    };
    socket.on('location:update', handler);
    return () => socket.off('location:update', handler);
  }, [socket, selected]);

  useEffect(() => {
    if (currentLoc && mapRef.current) {
      mapRef.current.panTo({ lat: parseFloat(currentLoc.latitude), lng: parseFloat(currentLoc.longitude) });
    }
  }, [currentLoc]);

  /* Both renderers report a tap; only the shape of the event differs, so each
     unwraps its own and this decides what a tap means. */
  const placeZoneAt = useCallback((lat, lng) => {
    if (!pickingOnMap) return;
    setZoneForm((f) => ({ ...f, latitude: lat.toFixed(6), longitude: lng.toFixed(6) }));
    setPickingOnMap(false);
    setShowZoneForm(true);
  }, [pickingOnMap]);

  /* ── Setting a position by hand ──────────────────────────────────────────
     Used for testing before a device is linked, and to correct a stale fix.
     Failures are reported inline; `alert()` is a modal a phone user has to
     dismiss before they can even see which field was wrong. */
  const setLocation = async ({ latitude, longitude, address }) => {
    if (!selected) return;
    setSimulating(true);
    setError('');
    try {
      await locationsApi.setManual(selected.id, {
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        accuracy: 10,
        address: address || null,
      });
      await loadLocation(selected);
      setShowSetLocation(false);
      setSimForm({ lat: '', lng: '', address: '' });
    } catch (err) {
      setError(errorMessage(err, 'Could not set that location.'));
    } finally {
      setSimulating(false);
    }
  };

  const useMyLocation = async () => {
    if (!navigator.geolocation) {
      setError('This browser cannot report a location.');
      return;
    }
    // Off a secure origin the browser rejects with PERMISSION_DENIED without ever
    // prompting, which reads as "you said no" to someone who was never asked.
    if (!window.isSecureContext) {
      setError('A browser only shares a location over HTTPS. Open this site over HTTPS, or use "Set by address".');
      return;
    }

    setSimulating(true);
    setError('');
    try {
      let pos;
      try {
        pos = await readPosition({ enableHighAccuracy: true, timeout: 10000 });
      } catch (err) {
        // A desktop has no GPS, so high accuracy just waits on one and times out.
        // The coarse Wi-Fi fix is far more precision than a safe zone needs.
        if (err.code === 1) throw err;
        pos = await readPosition({ enableHighAccuracy: false, timeout: 20000, maximumAge: 60000 });
      }
      await setLocation({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
    } catch (err) {
      setError(GEO_ERRORS[err?.code] || 'Could not read your location.');
    } finally {
      setSimulating(false);
    }
  };

  /* Google's geocoder when the key works, OpenStreetMap's when it does not —
     see services/geocode.js. Either way this needs no key of its own, so the
     field is offered in every deployment. */
  const geocodeAddress = async () => {
    const address = simForm.address.trim();
    if (!address) return;

    setSimulating(true);
    setError('');
    try {
      // `allowGoogle` is about the key, not about whether the script happens to
      // be loaded yet — the service checks that for itself.
      const match = await geocode(address, { allowGoogle: !mapsKeyMissing && !mapsRefused });
      await setLocation({
        latitude: match.latitude,
        longitude: match.longitude,
        address: match.formatted,
      });
    } catch (err) {
      setError(err.message || 'The address lookup failed.');
    } finally {
      setSimulating(false);
    }
  };

  /* ── Safe zones ──────────────────────────────────────────────────────── */
  const addZone = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const r = await safeZonesApi.create({
        ...zoneForm,
        childId: selected.id,
        latitude: parseFloat(zoneForm.latitude),
        longitude: parseFloat(zoneForm.longitude),
        radiusMeters: parseInt(zoneForm.radiusMeters, 10),
      });
      setZones((prev) => [...prev, r.data]);
      setShowZoneForm(false);
      setZoneForm(EMPTY_ZONE);
    } catch (err) {
      setError(errorMessage(err, 'Could not save that safe zone.'));
    }
  };

  const removeZone = async (id) => {
    setError('');
    try {
      await safeZonesApi.remove(id);
      setZones((prev) => prev.filter((z) => z.id !== id));
    } catch (err) {
      setError(errorMessage(err, 'Could not remove that safe zone.'));
    }
  };

  const toggleZone = async (zone) => {
    setError('');
    try {
      const r = await safeZonesApi.update(zone.id, { isActive: !zone.isActive });
      setZones((prev) => prev.map((z) => (z.id === zone.id ? r.data : z)));
    } catch (err) {
      setError(errorMessage(err, 'Could not update that safe zone.'));
    }
  };

  // A location row has to belong to a device, so the API rejects a hand-set
  // position for a child with none. Say so before the browser asks for a fix
  // that is going to be thrown away.
  const hasDevice = (selected?.devices?.length || 0) > 0;

  const mapCenter = currentLoc
    ? { lat: parseFloat(currentLoc.latitude), lng: parseFloat(currentLoc.longitude) }
    : DEFAULT_CENTER;

  /* The same two things the Google branch renders as children, in the shape the
     keyless renderer takes. Memoised because that one rebuilds its layers when
     these change, and `zones.filter(…)` is a fresh array on every keystroke in
     the dialog below it. */
  const activeZones = useMemo(() => zones.filter((z) => z.isActive).map((zone) => ({
    id: zone.id,
    lat: parseFloat(zone.latitude),
    lng: parseFloat(zone.longitude),
    radiusMeters: zone.radiusMeters,
    color: ZONE_COLORS[zone.type] || ZONE_COLORS.custom,
    title: zone.name,
    subtitle: `${zone.type} · ${zone.radiusMeters}m`,
  })), [zones]);

  const mapMarker = useMemo(() => (currentLoc && selected ? {
    lat: parseFloat(currentLoc.latitude),
    lng: parseFloat(currentLoc.longitude),
    title: selected.name,
    initial: selected.name[0].toUpperCase(),
    color: PRIMARY,
    lines: [
      currentLoc.address,
      `${parseFloat(currentLoc.latitude).toFixed(5)}, ${parseFloat(currentLoc.longitude).toFixed(5)}`,
      currentLoc.accuracy != null ? `±${Math.round(currentLoc.accuracy)}m accuracy` : null,
    ],
  } : null), [currentLoc, selected]);

  if (loading) return <p className="text-sm text-gray-400 py-8">Loading…</p>;

  if (childList.length === 0) {
    return (
      <div className="card">
        <EmptyState
          icon="location"
          title="No child profiles yet"
          description="Add a child and link their device to see where they are."
          action={<Link to="/dashboard/children" className="btn-primary">Go to Children</Link>}
        />
      </div>
    );
  }

  /* Which renderer draws the map. Google when this deployment has a key it can
     actually use; OpenStreetMap otherwise — a missing key, a script that never
     arrived, or a key Google refused all end in the same place, and none of them
     is a reason for a parent to lose the map. */
  const keyFailed = mapsRefused || mapsLoadFailed;
  const drawWithGoogle = !mapsKeyMissing && !keyFailed;

  /* A configured key that does not work is a job for whoever configured it, and
     for nobody else: the map is already drawn, so to a parent the notice is a
     sentence about billing and referrer allowlists in the middle of finding
     their child. Staff see it in the app they can act from; everyone else gets
     the working map, and the console carries the reason either way. */
  const explainKeyFailure = keyFailed && isStaff(user) && !LOCAL_ORIGIN;

  return (
    <div className="space-y-5">
      <PageIntro description="Live position and the safe zones you want to be told about." />

      <ChildTabs items={childList} selectedId={selected?.id} onSelect={setSelected} />

      {error && <p className="notice-error">{error}</p>}

      {selected && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6 items-start">
          {/* ── Map ───────────────────────────────────────────────────────── */}
          <div className="lg:col-span-2 space-y-3">
            <div className="card-flush">
              <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-100">
                <div className="min-w-0">
                  <p className="font-semibold text-sm text-gray-900 truncate">{selected.name}</p>
                  <p className="text-xs text-gray-400 truncate">
                    {locLoading
                      ? 'Fetching position…'
                      : locError
                        ? 'Position unavailable — could not reach the server'
                        : currentLoc
                          ? `Updated ${new Date(currentLoc.recordedAt || currentLoc.updatedAt).toLocaleTimeString()}`
                          : 'No position reported yet'}
                  </p>
                </div>
                <button
                  onClick={() => { setPickingOnMap((v) => !v); setShowZoneForm(false); }}
                  className={`btn-secondary btn-sm shrink-0 ${pickingOnMap ? 'border-primary-500 text-primary-600' : ''}`}
                >
                  <Icon name={pickingOnMap ? 'close' : 'plus'} size={15} />
                  {pickingOnMap ? 'Cancel' : 'Safe zone'}
                </button>
              </div>

              {/* Only when a key was configured and did not work — and only for
                  the people who can fix it, see `explainKeyFailure`. Without a
                  key Google's script is never loaded, so neither flag can be set
                  by a deployment that simply has none. */}
              {explainKeyFailure && (
                <p className="notice-warning rounded-none border-x-0 border-t-0">
                  <Icon name="warning" size={16} className="mt-0.5" />
                  <span>
                    {mapsRefused
                      ? `Google rejected the map key for ${window.location.host} — showing OpenStreetMap instead. Its allowed referrers, the Maps JavaScript API, or billing need attention in the Google Cloud console.`
                      : 'Google Maps failed to load — showing OpenStreetMap instead.'}
                  </span>
                </p>
              )}

              {pickingOnMap && (
                <p className="notice-info rounded-none border-x-0 border-t-0">
                  <Icon name="info" size={16} className="mt-0.5" />
                  <span>Tap the map where the zone should be centred.</span>
                </p>
              )}

              <div className="h-[300px] sm:h-[380px] lg:h-[460px] bg-gray-50">
                <Suspense
                  fallback={<p className="h-full flex items-center justify-center text-sm text-gray-400">Loading map…</p>}
                >
                  {drawWithGoogle ? (
                    <GoogleMapPane
                      ref={mapRef}
                      apiKey={MAPS_API_KEY}
                      center={mapCenter}
                      zoom={currentLoc ? 15 : DEFAULT_ZOOM}
                      marker={mapMarker}
                      circles={activeZones}
                      picking={pickingOnMap}
                      onClick={({ lat, lng }) => placeZoneAt(lat, lng)}
                      onLoadError={onMapsLoadError}
                    />
                  ) : (
                    <OpenMap
                      ref={mapRef}
                      center={mapCenter}
                      zoom={currentLoc ? 15 : DEFAULT_ZOOM}
                      marker={mapMarker}
                      circles={activeZones}
                      picking={pickingOnMap}
                      onClick={({ lat, lng }) => placeZoneAt(lat, lng)}
                    />
                  )}
                </Suspense>
              </div>
            </div>

            {!locLoading && !currentLoc && (
              <div className="notice-info">
                <Icon name="info" size={16} className="mt-0.5" />
                {hasDevice ? (
                  <span>
                    Nothing has been reported yet. The device sends its position once the Parentix app is
                    running — or you can set one by hand to try the safe zones.
                  </span>
                ) : (
                  <span>
                    No device is linked to {selected.name} yet, so nothing can report a position and a
                    position cannot be set by hand either.{' '}
                    <Link to="/dashboard/children" className="underline font-medium">Link a device</Link> to
                    get started.
                  </span>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                onClick={useMyLocation}
                disabled={simulating || !hasDevice}
                className="btn-secondary btn-sm"
              >
                <Icon name="location" size={15} />
                {simulating ? 'Working…' : 'Use my location'}
              </button>
              <button
                onClick={() => { setShowSetLocation(true); setError(''); }}
                disabled={!hasDevice}
                className="btn-secondary btn-sm"
              >
                <Icon name="search" size={15} />
                Set by address
              </button>
            </div>
          </div>

          {/* ── Side panel ────────────────────────────────────────────────── */}
          <div className="space-y-4">
            <div className="card">
              <h2 className="section-title mb-3">Current position</h2>
              {locLoading ? (
                <p className="text-sm text-gray-400">Fetching…</p>
              ) : currentLoc ? (
                <div className="space-y-3">
                  {currentLoc.address && <p className="text-sm text-gray-800">{currentLoc.address}</p>}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-gray-50 rounded-xl p-2.5 text-center">
                      <p className="text-[11px] text-gray-400 uppercase tracking-wide">Lat</p>
                      <p className="font-mono text-xs text-gray-900">{parseFloat(currentLoc.latitude).toFixed(5)}</p>
                    </div>
                    <div className="bg-gray-50 rounded-xl p-2.5 text-center">
                      <p className="text-[11px] text-gray-400 uppercase tracking-wide">Lng</p>
                      <p className="font-mono text-xs text-gray-900">{parseFloat(currentLoc.longitude).toFixed(5)}</p>
                    </div>
                  </div>
                  <dl className="text-xs text-gray-500 space-y-1">
                    {currentLoc.accuracy != null && (
                      <div className="flex justify-between"><dt>Accuracy</dt><dd>±{Math.round(currentLoc.accuracy)}m</dd></div>
                    )}
                    {currentLoc.speed != null && (
                      <div className="flex justify-between"><dt>Speed</dt><dd>{(currentLoc.speed * 3.6).toFixed(1)} km/h</dd></div>
                    )}
                    <div className="flex justify-between gap-3">
                      <dt>Reported</dt>
                      <dd className="text-right">
                        {new Date(currentLoc.recordedAt || currentLoc.updatedAt).toLocaleString()}
                      </dd>
                    </div>
                  </dl>
                </div>
              ) : (
                <p className="text-sm text-gray-400">No position reported yet.</p>
              )}
            </div>

            <div className="card">
              <div className="flex items-center justify-between gap-3 mb-3">
                <h2 className="section-title">Safe zones</h2>
                <button
                  onClick={() => { setZoneForm(EMPTY_ZONE); setShowZoneForm(true); }}
                  className="btn-ghost btn-sm"
                >
                  <Icon name="plus" size={15} strokeWidth={2.4} />
                  Add
                </button>
              </div>

              {zonesError ? (
                <div className="space-y-2">
                  <EmptyState compact icon="warning" title="Could not load your safe zones" description={zonesError} />
                  <button onClick={() => loadZones(selected)} className="btn-secondary btn-sm">
                    Try again
                  </button>
                </div>
              ) : zones.length === 0 ? (
                <EmptyState
                  compact
                  icon="location"
                  title="No safe zones"
                  description="Add one to be told when your child arrives or leaves."
                />
              ) : (
                <div className="space-y-2">
                  {zones.map((zone) => (
                    <div
                      key={zone.id}
                      className={`flex items-center gap-3 p-2.5 rounded-xl border border-gray-100 ${
                        zone.isActive ? '' : 'opacity-60'
                      }`}
                    >
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ background: ZONE_COLORS[zone.type] || ZONE_COLORS.custom }}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{zone.name}</p>
                        <p className="text-xs text-gray-500 capitalize">{zone.type} · {zone.radiusMeters}m</p>
                      </div>
                      <Toggle
                        checked={!!zone.isActive}
                        size="sm"
                        onChange={() => toggleZone(zone)}
                        aria-label={`${zone.isActive ? 'Disable' : 'Enable'} ${zone.name}`}
                      />
                      <button
                        onClick={() => removeZone(zone.id)}
                        className="icon-btn w-9 h-9 text-gray-400 hover:text-danger"
                        aria-label={`Remove ${zone.name}`}
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap gap-3 mt-4 pt-3 border-t border-gray-50">
                {Object.entries(ZONE_COLORS).map(([type, color]) => (
                  <span key={type} className="flex items-center gap-1.5 text-xs text-gray-500 capitalize">
                    <span className="w-2 h-2 rounded-full" style={{ background: color }} />
                    {type}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── New safe zone ──────────────────────────────────────────────────── */}
      <Modal
        open={showZoneForm}
        onClose={() => setShowZoneForm(false)}
        title="New safe zone"
        description="You will be alerted when your child enters or leaves it."
      >
        <form onSubmit={addZone} className="space-y-4">
          <label className="field">
            <span className="field-label">Name</span>
            <input
              className="input" placeholder="e.g. Home, School" required value={zoneForm.name}
              onChange={(e) => setZoneForm({ ...zoneForm, name: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Type</span>
            <select
              className="input" value={zoneForm.type}
              onChange={(e) => setZoneForm({ ...zoneForm, type: e.target.value })}
            >
              <option value="home">Home</option>
              <option value="school">School</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="field">
              <span className="field-label">Latitude</span>
              <input
                className="input" type="number" step="any" inputMode="decimal" required
                value={zoneForm.latitude}
                onChange={(e) => setZoneForm({ ...zoneForm, latitude: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">Longitude</span>
              <input
                className="input" type="number" step="any" inputMode="decimal" required
                value={zoneForm.longitude}
                onChange={(e) => setZoneForm({ ...zoneForm, longitude: e.target.value })}
              />
            </label>
          </div>
          <label className="field">
            <span className="field-label">Radius (metres)</span>
            <input
              className="input" type="number" min="50" max="5000" inputMode="numeric"
              value={zoneForm.radiusMeters}
              onChange={(e) => setZoneForm({ ...zoneForm, radiusMeters: e.target.value })}
            />
          </label>

          <div className="divide-y divide-gray-50">
            <Toggle
              label="Alert me on arrival"
              size="sm"
              checked={zoneForm.notifyOnEnter}
              onChange={(v) => setZoneForm({ ...zoneForm, notifyOnEnter: v })}
            />
            <Toggle
              label="Alert me on leaving"
              size="sm"
              checked={zoneForm.notifyOnLeave}
              onChange={(v) => setZoneForm({ ...zoneForm, notifyOnLeave: v })}
            />
          </div>

          <button type="submit" className="btn-primary btn-block" disabled={!zoneForm.name.trim()}>
            Save safe zone
          </button>
        </form>
      </Modal>

      {/* ── Set position by hand ───────────────────────────────────────────── */}
      <Modal
        open={showSetLocation}
        onClose={() => setShowSetLocation(false)}
        title="Set a position"
        description="Useful before a device is linked, or to correct a stale fix."
      >
        <div className="space-y-4">
          <label className="field">
            <span className="field-label">Address</span>
            <div className="flex gap-2">
              <input
                className="input flex-1"
                placeholder="123 Main St, Toronto — or anywhere in the world"
                value={simForm.address}
                onChange={(e) => setSimForm({ ...simForm, address: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); geocodeAddress(); } }}
              />
              {/* Google's geocoder needs a key that works; without one the
                  lookup goes to OpenStreetMap's, so the button is never dead. */}
              <button
                type="button"
                onClick={geocodeAddress}
                disabled={simulating || !simForm.address.trim()}
                className="btn-primary px-4 shrink-0"
              >
                {simulating ? '…' : 'Find'}
              </button>
            </div>
            {!drawWithGoogle && (
              <span className="field-hint">
                Looked up with OpenStreetMap. If nothing matches, add a city and country — or enter coordinates below.
              </span>
            )}
          </label>

          <div className="flex items-center gap-3">
            <span className="flex-1 h-px bg-gray-100" />
            <span className="text-xs text-gray-400">or coordinates</span>
            <span className="flex-1 h-px bg-gray-100" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="field">
              <span className="field-label">Latitude</span>
              <input
                className="input" type="number" step="any" inputMode="decimal" placeholder="43.6532"
                value={simForm.lat} onChange={(e) => setSimForm({ ...simForm, lat: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">Longitude</span>
              <input
                className="input" type="number" step="any" inputMode="decimal" placeholder="-79.3832"
                value={simForm.lng} onChange={(e) => setSimForm({ ...simForm, lng: e.target.value })}
              />
            </label>
          </div>

          {error && <p className="notice-error">{error}</p>}

          <button
            type="button"
            className="btn-primary btn-block"
            disabled={simulating || !simForm.lat || !simForm.lng}
            onClick={() => setLocation({ latitude: simForm.lat, longitude: simForm.lng, address: simForm.address })}
          >
            {simulating ? 'Saving…' : 'Set position'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
