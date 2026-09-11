import * as SecureStore from 'expo-secure-store';

/**
 * JSON persistence for values that must survive an app or device restart while
 * the device is offline, and that hold personal data — so SecureStore rather
 * than a plain file.
 *
 * SecureStore is documented as unreliable above 2048 bytes per value, and an
 * approved-contact list passes that at roughly twenty entries. Values are
 * therefore split across numbered keys, with a count key naming how many parts
 * make up the whole. A read that finds fewer parts than the count advertises
 * treats the entry as absent rather than returning half a contact list.
 */
const CHUNK_SIZE = 1800;

const countKey = (key) => `${key}__parts`;
const partKey = (key, i) => `${key}__${i}`;

/**
 * One write at a time per key.
 *
 * A value here is not one store operation but several — a part per 1800 bytes,
 * then the count, then the tail of a previous longer value. The note on
 * `writeJson` explains why that order is safe against a concurrent *read*; it is
 * not safe against a concurrent *write*, and two of those is an ordinary
 * situation on this device rather than an exotic one. `webHistory.js` persists
 * its queue both from the native visit callback and from inside the upload loop,
 * so a visit arriving mid-upload has always been able to interleave two values'
 * chunks under one count — producing either a parse failure, which
 * `readJson` absorbs as "no backlog", or a syntactically valid list assembled
 * from two different ones.
 *
 * Serialising per key makes the multi-step write behave like the single
 * operation every caller already assumes it is: the last writer wins, having
 * seen the whole of the previous one land. Different keys still write in
 * parallel; entries are dropped once settled, so the map cannot grow.
 *
 * The desktop agent's `store.js` does the same thing for the same reason.
 */
const _writes = new Map();

const serialize = (key, work) => {
  const previous = _writes.get(key) || Promise.resolve();
  // `.catch` before chaining: one failed write must not poison the key for the
  // rest of the session.
  const next = previous.catch(() => {}).then(work);
  _writes.set(key, next);
  next.catch(() => {}).finally(() => {
    if (_writes.get(key) === next) _writes.delete(key);
  });
  return next;
};

const readCount = async (key) => {
  const raw = await SecureStore.getItemAsync(countKey(key));
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/** Remove every part of a previous write, so a shorter value leaves no tail. */
const clearParts = async (key, count) => {
  for (let i = 0; i < count; i += 1) {
    await SecureStore.deleteItemAsync(partKey(key, i));
  }
};

export async function readJson(key, fallback = null) {
  try {
    const count = await readCount(key);
    if (count === null) return fallback;

    let serialized = '';
    for (let i = 0; i < count; i += 1) {
      const part = await SecureStore.getItemAsync(partKey(key, i));
      // A partial write (killed mid-save) must not deserialize into a truncated
      // list that then looks authoritative.
      if (part === null) return fallback;
      serialized += part;
    }
    return JSON.parse(serialized);
  } catch {
    return fallback;
  }
}

export function writeJson(key, value) {
  // Serialised to JSON outside the queue, so what is written is the value as it
  // was at the call, not as it may have become while an earlier write drained.
  const serialized = JSON.stringify(value);

  return serialize(key, async () => {
    const chunks = [];
    for (let i = 0; i < serialized.length; i += CHUNK_SIZE) {
      chunks.push(serialized.slice(i, i + CHUNK_SIZE));
    }

    const previous = (await readCount(key)) ?? 0;

    // The count is written last. Until it lands, a concurrent read still sees
    // the old count and the old parts, so it never observes a half-written
    // value.
    for (let i = 0; i < chunks.length; i += 1) {
      await SecureStore.setItemAsync(partKey(key, i), chunks[i]);
    }
    await SecureStore.setItemAsync(countKey(key), String(chunks.length));

    for (let i = chunks.length; i < previous; i += 1) {
      await SecureStore.deleteItemAsync(partKey(key, i));
    }
  });
}

/**
 * On the same chain as `writeJson`, so a removal cannot be overtaken by a write
 * already in flight and leave the value behind. This is what clears the rules
 * cache and the history backlog when the parent unlinks the device.
 */
export function removeJson(key) {
  return serialize(key, async () => {
    const count = (await readCount(key)) ?? 0;
    await clearParts(key, count);
    await SecureStore.deleteItemAsync(countKey(key));
  });
}
