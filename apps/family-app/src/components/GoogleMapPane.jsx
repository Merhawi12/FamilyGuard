import { Fragment, forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { GoogleMap, useLoadScript, Marker, Circle, InfoWindow } from '@react-google-maps/api';

/**
 * The Location page's map, drawn by Google.
 *
 * This lives apart from the page for one reason: `useLoadScript` is a hook, so
 * a page that called it could not *not* call it. A deployment with no Maps key
 * therefore fetched Google's Maps JavaScript API on every visit to Location,
 * had it fail authentication, and drew the keyless map anyway — a round trip and
 * a console error for a script whose output was never going to be rendered. In
 * its own component the hook only runs when the page mounts it, which it does
 * only when there is a key to run it with.
 *
 * It takes the same normalised marker and circles that OpenMap does, and exposes
 * the same `panTo`, so the page follows a child's position with one piece of
 * code no matter which renderer is underneath it.
 */

const MAP_STYLES = [{ featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] }];

const GoogleMapPane = forwardRef(function GoogleMapPane({
  apiKey,
  center,
  zoom,
  marker = null,
  circles = [],
  picking = false,
  onClick,
  onLoadError,
}, ref) {
  const { isLoaded, loadError } = useLoadScript({ googleMapsApiKey: apiKey });
  const mapRef = useRef(null);
  const [activeInfo, setActiveInfo] = useState(null); // 'child' | zone.id

  useImperativeHandle(ref, () => ({
    panTo: ({ lat, lng }) => mapRef.current?.panTo({ lat, lng }),
  }), []);

  // A script that never arrives is the page's decision to make, not this
  // component's: it is the one that owns the fallback.
  useEffect(() => { if (loadError) onLoadError?.(loadError); }, [loadError, onLoadError]);

  if (loadError || !isLoaded) {
    return <p className="h-full flex items-center justify-center text-sm text-gray-400">Loading map…</p>;
  }

  return (
    <GoogleMap
      mapContainerStyle={{ width: '100%', height: '100%' }}
      center={center}
      zoom={zoom}
      onLoad={(map) => { mapRef.current = map; }}
      onClick={(e) => onClick?.({ lat: e.latLng.lat(), lng: e.latLng.lng() })}
      options={{
        styles: MAP_STYLES,
        streetViewControl: false,
        mapTypeControl: false,
        fullscreenControl: true,
        zoomControl: true,
        // The default control cluster crowds a phone screen.
        gestureHandling: 'greedy',
        draggableCursor: picking ? 'crosshair' : undefined,
      }}
    >
      {marker && (
        <>
          <Marker
            position={{ lat: marker.lat, lng: marker.lng }}
            title={marker.title}
            onClick={() => setActiveInfo('child')}
            icon={{
              url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`
                <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
                  <circle cx="20" cy="20" r="17" fill="${marker.color}" stroke="white" stroke-width="3"/>
                  <text x="20" y="26" text-anchor="middle" font-family="sans-serif" font-size="17" fill="white">${marker.initial}</text>
                </svg>`)}`,
              scaledSize: { width: 40, height: 40 },
              anchor: { x: 20, y: 20 },
            }}
          />
          {activeInfo === 'child' && (
            <InfoWindow
              position={{ lat: marker.lat, lng: marker.lng }}
              onCloseClick={() => setActiveInfo(null)}
            >
              <div className="text-sm min-w-[140px]">
                <p className="font-bold text-gray-900">{marker.title}</p>
                {marker.lines.filter(Boolean).map((line, i) => (
                  <p key={line} className={i === 0 ? 'text-gray-600 mt-1' : 'text-gray-400 text-xs mt-1'}>{line}</p>
                ))}
              </div>
            </InfoWindow>
          )}
        </>
      )}

      {circles.map((zone) => (
        <Fragment key={zone.id}>
          <Circle
            center={{ lat: zone.lat, lng: zone.lng }}
            radius={zone.radiusMeters}
            options={{
              strokeColor: zone.color, strokeOpacity: 0.9, strokeWeight: 2,
              fillColor: zone.color, fillOpacity: 0.15,
              // While a zone is being placed the click belongs to the map
              // underneath: tapping inside an existing circle must still drop
              // the new one there.
              clickable: !picking,
            }}
            onClick={() => setActiveInfo(zone.id)}
          />
          {activeInfo === zone.id && (
            <InfoWindow
              position={{ lat: zone.lat, lng: zone.lng }}
              onCloseClick={() => setActiveInfo(null)}
            >
              <div className="text-sm min-w-[120px]">
                <p className="font-bold text-gray-900">{zone.title}</p>
                <p className="text-gray-500 capitalize text-xs mt-0.5">{zone.subtitle}</p>
              </div>
            </InfoWindow>
          )}
        </Fragment>
      ))}
    </GoogleMap>
  );
});

export default GoogleMapPane;
