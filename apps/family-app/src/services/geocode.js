/**
 * Turning "123 Main St, Toronto" into a position, with or without a Google key.
 *
 * The Location page offers this for the two cases a coordinate pair cannot
 * cover: trying the safe zones before a device is linked, and correcting a fix
 * that has gone stale. It used to be Google's geocoder alone, which meant it was
 * dead in exactly the deployments the map was dead in — and it was also the
 * first thing to fail on a key that loads maps but has never had the *Geocoding*
 * API enabled, which is a separate switch in the Cloud console and easy to miss.
 *
 * So: Google when it is there and answering, and Nominatim — OpenStreetMap's
 * public geocoder, no key, no account — when it is not. Nominatim's usage policy
 * allows this shape of use (a person pressing a button, at most two requests,
 * one at a time, identified by the browser's Referer) and rules out bulk or
 * autocomplete traffic, so nothing here may be wired to a keystroke.
 *
 * Both are biased to Canada rather than limited to it: an address is tried
 * against Canada first and retried worldwide only when that finds nothing, so
 * "127 Main St" resolves at home instead of in Ohio while "10 Downing Street,
 * London" still works.
 */

const HOME_COUNTRY = 'CA';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const LOOKUP_TIMEOUT_MS = 12000;

/** Whether Google's geocoder is loaded on the page at all. */
export const googleGeocoderReady = () => typeof window !== 'undefined'
  && typeof window.google?.maps?.Geocoder === 'function';

/**
 * A failure the parent should read as their own to fix (a misspelt address),
 * rather than one worth falling back over (the key is not allowed to geocode).
 */
class NoMatch extends Error {}

const googleLookup = (geocoder, request) => new Promise((resolve) => {
  geocoder.geocode(request, (results, status) => resolve({ results, status }));
});

async function viaGoogle(address) {
  const geocoder = new window.google.maps.Geocoder();

  // `region` alone only nudges the ranking, which is not enough to stop a bare
  // street address landing in the States. Restricting the first pass and
  // dropping the restriction on the second gives a firm preference without ever
  // making an address outside Canada unreachable.
  let { results, status } = await googleLookup(geocoder, {
    address,
    componentRestrictions: { country: HOME_COUNTRY },
  });

  if (status === 'ZERO_RESULTS') {
    ({ results, status } = await googleLookup(geocoder, { address, region: HOME_COUNTRY }));
  }

  if (status === 'OK' && results?.[0]) {
    const location = results[0].geometry.location;
    return {
      latitude: location.lat(),
      longitude: location.lng(),
      formatted: results[0].formatted_address,
    };
  }

  if (status === 'ZERO_RESULTS') {
    throw new NoMatch('No match anywhere in the world. Check the spelling, or add a city and country.');
  }

  // REQUEST_DENIED (Geocoding API off, or the key refused), OVER_QUERY_LIMIT,
  // and the transport errors. None of them are about the address, so the caller
  // retries them somewhere that has no key at all.
  throw new Error(`Google could not look that address up (${status}).`);
}

/* `AbortSignal.timeout` is not in the WebView on an Android phone that stopped
   taking updates a few years ago, and this ships inside one. Without the guard
   the missing method throws a TypeError that reads, four lines down, as "could
   not reach the service" — for a request that was never made. */
const lookupTimeout = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
  ? AbortSignal.timeout(LOOKUP_TIMEOUT_MS)
  : undefined);

async function nominatimLookup(params) {
  const url = `${NOMINATIM_URL}?${new URLSearchParams({
    q: params.q,
    format: 'jsonv2',
    limit: '1',
    ...(params.countrycodes ? { countrycodes: params.countrycodes } : {}),
  })}`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: lookupTimeout(),
  });

  if (res.status === 429) {
    throw new Error('The free address lookup is busy right now. Try again in a moment, or enter coordinates.');
  }
  if (!res.ok) throw new Error(`The address lookup failed (HTTP ${res.status}).`);
  return res.json();
}

async function viaNominatim(address) {
  let matches = await nominatimLookup({ q: address, countrycodes: HOME_COUNTRY.toLowerCase() });
  if (!matches?.length) matches = await nominatimLookup({ q: address });

  const best = matches?.[0];
  if (!best) {
    throw new NoMatch('No match anywhere in the world. Check the spelling, or add a city and country.');
  }

  return {
    latitude: parseFloat(best.lat),
    longitude: parseFloat(best.lon),
    formatted: best.display_name,
  };
}

/**
 * The position of a free-text address.
 *
 * @param {string} address
 * @param {{ allowGoogle?: boolean }} options `allowGoogle: false` skips Google
 *   even when its script is loaded — the Location page passes it once Google has
 *   refused the key, because the same key is what geocoding would authenticate
 *   with.
 * @returns {Promise<{ latitude: number, longitude: number, formatted: string }>}
 * @throws {Error} with a message written for a parent to read.
 */
export async function geocode(address, { allowGoogle = true } = {}) {
  const query = address.trim();
  if (!query) throw new Error('Enter an address first.');

  if (allowGoogle && googleGeocoderReady()) {
    try {
      return await viaGoogle(query);
    } catch (err) {
      if (err instanceof NoMatch) throw err;
      // Google is configured but cannot answer. Say nothing about it to the
      // parent — the free geocoder is about to give them the same answer.
      console.warn('Google geocoding unavailable, falling back to OpenStreetMap:', err.message);
    }
  }

  try {
    return await viaNominatim(query);
  } catch (err) {
    if (err instanceof NoMatch) throw err;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error('The address lookup timed out. Try again, or enter coordinates.');
    }
    if (err instanceof TypeError) {
      throw new Error('Could not reach the address lookup service. Check the connection, or enter coordinates.');
    }
    throw err;
  }
}
