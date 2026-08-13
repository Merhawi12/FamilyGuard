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

/** How stale a reported fix may be and still be taken at its word. */
const MAX_FIX_AGE_MS = 24 * 60 * 60 * 1000;
/** Slack for a device clock that runs a little fast. */
const MAX_FIX_SKEW_MS = 2 * 60 * 1000;

/**
 * When the fix was taken, if the device said so credibly — otherwise null, and
 * the caller falls back to the moment it arrived.
 *
 * Android buffers background location while the phone is dozing and delivers the
 * batch when it next wakes, so "now" can be a long way from when the child was
 * actually there. The device is the only party that knows the difference, which
 * is why this is accepted at all.
 *
 * It is bounded because a device clock is not evidence. A future timestamp would
 * pin a point permanently at the top of a history ordered by `recordedAt` — the
 * query behind "where is my child right now" — and an arbitrarily old one would
 * let a phone rewrite where it had been. Outside the window a genuinely delayed
 * fix could occupy, the claim is dropped rather than honoured.
 */
const toRecordedAt = (value, now = Date.now()) => {
  if (value == null || typeof value === 'boolean') return null;
  const at = new Date(typeof value === 'number' ? value : String(value));
  const ms = at.getTime();
  if (Number.isNaN(ms)) return null;
  if (ms > now + MAX_FIX_SKEW_MS) return null;
  if (ms < now - MAX_FIX_AGE_MS) return null;
  return at;
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
    recordedAt: toRecordedAt(body.recordedAt),
  };
};

const INVALID_FIX =
  'latitude must be a number between -90 and 90, and longitude between -180 and 180';

module.exports = { toCoordinate, toOptionalNumber, toRecordedAt, parseFix, INVALID_FIX };
