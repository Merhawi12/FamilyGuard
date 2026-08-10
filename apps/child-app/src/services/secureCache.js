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

export async function writeJson(key, value) {
  const serialized = JSON.stringify(value);
  const chunks = [];
  for (let i = 0; i < serialized.length; i += CHUNK_SIZE) {
    chunks.push(serialized.slice(i, i + CHUNK_SIZE));
  }

  const previous = (await readCount(key)) ?? 0;

  // The count is written last. Until it lands, a concurrent read still sees the
  // old count and the old parts, so it never observes a half-written value.
  for (let i = 0; i < chunks.length; i += 1) {
    await SecureStore.setItemAsync(partKey(key, i), chunks[i]);
  }
  await SecureStore.setItemAsync(countKey(key), String(chunks.length));

  for (let i = chunks.length; i < previous; i += 1) {
    await SecureStore.deleteItemAsync(partKey(key, i));
  }
}

export async function removeJson(key) {
  const count = (await readCount(key)) ?? 0;
  await clearParts(key, count);
  await SecureStore.deleteItemAsync(countKey(key));
}
