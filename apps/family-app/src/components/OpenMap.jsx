import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/**
 * The map the Location page draws when Google's is not available.
 *
 * A Maps JavaScript key is a per-deployment, billing-backed secret, and until it
 * is set — or when Google refuses the one that is — the page had nothing to show
 * but a "Map unavailable" panel where the map goes. That is the single most
 * important element of the screen, and it was absent in every deployment that
 * had not been through the Cloud console. OpenStreetMap raster tiles need no key
 * and no account, so the page can always draw a real map: the child's position,
 * the safe zones around it, and a tap to place a new one.
 *
 * Leaflet rather than a React wrapper because this is the only screen that uses
 * it and the wrapper would be more code than the ~120 lines below. It is also
 * imported lazily by Location.jsx, so a deployment that *does* have a Google key
 * never downloads it.
 *
 * The imperative handle deliberately mirrors the one method the page calls on
 * `google.maps.Map` — `panTo({ lat, lng })` — so the socket handler and the
 * follow-the-fix effect are written once and work against either renderer.
 */

/* Tiles come from OpenStreetMap's public servers by default. Their tile usage
   policy asks for attribution (rendered by Leaflet's attribution control, which
   is why it is left on) and rules out heavy, systematic use, so a deployment
   that outgrows it points these at its own or a paid provider instead of
   editing this file. */
const TILE_URL = import.meta.env.VITE_MAP_TILE_URL
  || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = import.meta.env.VITE_MAP_TILE_ATTRIBUTION
  || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/* The same 40px disc the Google marker draws, so the two renderers do not look
   like two different products. `divIcon` also sidesteps Leaflet's default
   marker, whose PNGs are the classic thing to break under a bundler. */
const markerIcon = (initial, color) => L.divIcon({
  className: '',
  iconSize: [40, 40],
  iconAnchor: [20, 20],
  popupAnchor: [0, -22],
  html: `
    <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
      <circle cx="20" cy="20" r="17" fill="${escapeHtml(color)}" stroke="white" stroke-width="3"/>
      <text x="20" y="26" text-anchor="middle" font-family="sans-serif" font-size="17" fill="white">${escapeHtml(initial)}</text>
    </svg>`,
});

/** Popup content as DOM rather than HTML: every value here is user-supplied. */
const popupNode = ({ title, lines = [] }) => {
  const root = document.createElement('div');
  root.className = 'text-sm min-w-[120px]';

  const heading = document.createElement('p');
  heading.className = 'font-bold text-gray-900';
  heading.textContent = title;
  root.appendChild(heading);

  for (const line of lines.filter(Boolean)) {
    const p = document.createElement('p');
    p.className = 'text-gray-500 text-xs mt-0.5';
    p.textContent = line;
    root.appendChild(p);
  }
  return root;
};

const OpenMap = forwardRef(function OpenMap({
  center,
  zoom,
  marker = null,
  circles = [],
  picking = false,
  onClick,
}, ref) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const circleRefs = useRef(new Map());
  const viewRef = useRef(null);
  const clickRef = useRef(onClick);
  const [tilesFailed, setTilesFailed] = useState(false);

  clickRef.current = onClick;

  useImperativeHandle(ref, () => ({
    panTo: ({ lat, lng }) => mapRef.current?.panTo([lat, lng]),
  }), []);

  // Created once. Everything below reaches into it rather than re-rendering it,
  // which is also what keeps a parent's own panning from being undone by an
  // unrelated state change on the page.
  useEffect(() => {
    const drawnCircles = circleRefs.current;
    // One finger pans and two pinch, which is what Google's map is given
    // `gestureHandling: 'greedy'` for; Leaflet needs no option to behave that way.
    const map = L.map(containerRef.current, {
      center: [center.lat, center.lng],
      zoom,
      zoomControl: true,
    });
    mapRef.current = map;
    viewRef.current = { lat: center.lat, lng: center.lng, zoom };

    // A blank grey square is indistinguishable from "the child is in the middle
    // of the ocean", so a tile server that cannot be reached says so. Only when
    // nothing at all has rendered: a single missing tile at the edge of a pan is
    // normal and not worth a banner.
    let loadedAny = false;
    L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19 })
      .on('tileload', () => { loadedAny = true; setTilesFailed(false); })
      .on('tileerror', () => { if (!loadedAny) setTilesFailed(true); })
      .addTo(map);

    map.on('click', (e) => clickRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      drawnCircles.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the view the page asks for, but only when it actually changed —
  // `center` is a fresh object on every render, so acting on identity would
  // yank the map back the moment anything else on the page updated.
  useEffect(() => {
    const map = mapRef.current;
    const was = viewRef.current;
    if (!map || !was) return;
    if (was.lat === center.lat && was.lng === center.lng && was.zoom === zoom) return;
    viewRef.current = { lat: center.lat, lng: center.lng, zoom };
    map.setView([center.lat, center.lng], zoom);
  }, [center.lat, center.lng, zoom]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!marker) {
      if (markerRef.current) { markerRef.current.remove(); markerRef.current = null; }
      return;
    }

    const position = [marker.lat, marker.lng];
    if (!markerRef.current) {
      markerRef.current = L.marker(position, {
        icon: markerIcon(marker.initial, marker.color),
        title: marker.title,
        keyboard: false,
      }).addTo(map);
    } else {
      markerRef.current.setLatLng(position);
      markerRef.current.setIcon(markerIcon(marker.initial, marker.color));
    }
    // `setContent` rather than a fresh `bindPopup` when one is already there:
    // rebinding leaves an open popup showing the position it was opened at,
    // which for a child who has just moved is the one thing it must not do.
    const content = popupNode({ title: marker.title, lines: marker.lines });
    const popup = markerRef.current.getPopup();
    if (popup) popup.setContent(content);
    else markerRef.current.bindPopup(content);
  }, [marker]);

  // Keyed by id and rebuilt only where something changed: re-adding every circle
  // on every render would close a popup the parent had just opened.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const live = new Set();
    for (const zone of circles) {
      live.add(zone.id);
      const signature = JSON.stringify([zone.lat, zone.lng, zone.radiusMeters, zone.color, zone.title, zone.subtitle, picking]);
      const existing = circleRefs.current.get(zone.id);
      if (existing?.signature === signature) continue;
      existing?.layer.remove();

      const layer = L.circle([zone.lat, zone.lng], {
        radius: zone.radiusMeters,
        color: zone.color,
        weight: 2,
        opacity: 0.9,
        fillColor: zone.color,
        fillOpacity: 0.15,
        // While a zone is being placed the click belongs to the map underneath:
        // tapping inside an existing circle must still drop the new one there.
        interactive: !picking,
      }).addTo(map);
      if (!picking) layer.bindPopup(popupNode({ title: zone.title, lines: [zone.subtitle] }));
      circleRefs.current.set(zone.id, { layer, signature });
    }

    for (const [id, entry] of circleRefs.current) {
      if (live.has(id)) continue;
      entry.layer.remove();
      circleRefs.current.delete(id);
    }
  }, [circles, picking]);

  // Inline, so it beats the cursor Leaflet's own `.leaflet-grab` class sets.
  useEffect(() => {
    const map = mapRef.current;
    if (map) map.getContainer().style.cursor = picking ? 'crosshair' : '';
  }, [picking]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full z-0" />
      {/* A notice, not a curtain: with no tiles the map still draws the marker
          and the safe-zone circles over an empty background, and it can still be
          panned and tapped — so nothing here may sit between them and a finger. */}
      {tilesFailed && (
        <div className="absolute inset-x-0 top-0 z-[500] pointer-events-none flex justify-center p-2">
          <p className="notice-warning text-xs shadow-sm">
            Map tiles could not be loaded — check the connection. Everything else on this page still works.
          </p>
        </div>
      )}
    </div>
  );
});

export default OpenMap;
