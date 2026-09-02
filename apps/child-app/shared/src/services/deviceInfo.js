import { Platform } from 'react-native';
import * as Device from 'expo-device';

/**
 * What this handset knows about itself and the parent's dashboard does not.
 *
 * The desktop agent has reported both of these since it shipped (see
 * `linkThisDevice` in child-desktop's agent.js); the phone reported neither, and
 * the gap is visible in three places the parent and support actually look:
 * `DeviceCard`, the "just linked" confirmation on the Children screen, and the
 * console's fleet table — which prints a literal "version unknown" under every
 * row and exports the empty column to CSV. Since laptops fill it in and phones
 * never did, the fleet screen read as though the phones were the broken ones.
 *
 * Reported once, as the device links. There is no later opportunity: nothing
 * else on either side ever revisits these columns.
 */

/**
 * The `type` column's value for this handset.
 *
 * Only ever 'android' or 'ios' — a phone cannot be mistaken about which of the
 * two it is running, which is the whole reason this is worth sending. The parent
 * chose a type when they generated the code, from a screen that is by definition
 * not this device, and nothing corrected them.
 *
 * Anything the API does not recognise is ignored rather than refused (see
 * `DEVICE_TYPES` in deviceController), so an unexpected `Platform.OS` on some
 * future target cannot stop a child linking their phone.
 */
export const thisDeviceType = () => (Platform.OS === 'ios' ? 'ios' : 'android');

/**
 * A human-readable OS version, in the same register as the desktop's
 * "Windows 11 Pro 10.0.26200" — this is display text on a parent's device list,
 * not something either side parses.
 *
 * `expo-device` is asked first because it gives the marketing version a person
 * recognises ("Android 14"). `Platform.Version` is the fallback and is
 * deliberately second: on Android it is the API level (34), which is the right
 * answer to a different question and would read as a nonsense version number.
 * Null rather than a guess when neither answers — the column is nullable and the
 * screens already have wording for an empty one.
 */
export const thisOsVersion = () => {
  const name = Device.osName || (Platform.OS === 'ios' ? 'iOS' : 'Android');
  const version = Device.osVersion || (Platform.OS === 'ios' ? Platform.Version : null);
  return version ? `${name} ${version}` : null;
};
