/**
 * Coordinate validation, shared by every path that accepts a position fix: the
 * device's REST report, the socket update that drives the live map, and the
 * position a parent sets by hand.
 *
 * The device endpoint used to check only that latitude and longitude were not
 * null, so `"abc"` was stored as NaN, `999` as a latitude that cannot exist, and
 * `true` as 1. Each of those is worse than a rejection: a NaN fix serialises to
 * `null` in JSON, so the parent's map silently plots nothing, and — because every
 * comparison against NaN is false — the geofence check quietly stops raising
 * enter/leave alerts for that report. A parent watching for "left school" would
 * simply never be told.
 */

/**
 * A single coordinate within `±limit`, or null.
 *
 * Booleans, objects and blank strings are rejected rather than coerced:
 * `Number(true)` is a perfectly plausible-looking 1, and `Number('')` is 0 —
 * a valid point in the Gulf of Guinea.
 */
const toCoordinate = (value, limit) => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > limit) return null;
  return n;
};

/** An optional numeric field — dropped rather than stored as NaN. */
const toOptionalNumber = (value) => {
  if (value == null) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Turns a request body or socket payload into a fix worth recording, or null if
 * it is not one. `address` is free text from a geocoder, so it is length-capped
 * to the column rather than parsed.
 */
const parseFix = (body) => {
  const latitude = toCoordinate(body?.latitude, 90);
  const longitude = toCoordinate(body?.longitude, 180);
  if (latitude === null || longitude === null) return null;

  return {
    latitude,
    longitude,
    accuracy: toOptionalNumber(body.accuracy),
    speed: toOptionalNumber(body.speed),
    heading: toOptionalNumber(body.heading),
    address: typeof body.address === 'string' ? body.address.slice(0, 255) : null,
  };
};

const INVALID_FIX =
  'latitude must be a number between -90 and 90, and longitude between -180 and 180';

module.exports = { toCoordinate, toOptionalNumber, parseFix, INVALID_FIX };
