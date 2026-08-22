import * as SecureStore from 'expo-secure-store';
import { onUnlinked } from './link';
import { getRules } from './rules';

const KEY = 'fg_child_name';
let cached = null;

// The stored copy goes with the credentials; this is the one in memory, which
// would otherwise greet the next child by the previous child's name.
onUnlinked(() => { cached = null; });

/**
 * The child's first name, for the greeting.
 *
 * It arrives alongside the rules, which means it is not available on a cold
 * start until the first sync answers — so it is remembered here. Nothing
 * depends on it: every screen reads fine with no name at all.
 */
export async function loadChildName() {
  const fromRules = getRules().childName;

  if (fromRules) {
    if (fromRules !== cached) {
      cached = fromRules;
      SecureStore.setItemAsync(KEY, fromRules).catch(() => {});
    }
    return fromRules;
  }

  if (cached) return cached;
  cached = await SecureStore.getItemAsync(KEY).catch(() => null);
  return cached;
}
