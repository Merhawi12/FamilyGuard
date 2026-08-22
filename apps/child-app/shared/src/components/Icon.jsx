import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';

/**
 * The app's icon vocabulary.
 *
 * Screens ask for a *meaning* — `menu`, `bedtime`, `blocked` — not a glyph
 * name. The emoji this app used before were rendered by the OS, so the same
 * "🔒" was a flat glyph on one phone and a glossy 3D padlock on another, none
 * of them took the surrounding colour, and none sat on the text baseline.
 *
 * Ionicons ships inside `@expo/vector-icons`, which Expo already bundles — no
 * native module, so nothing here needs a new Android build.
 */
const GLYPHS = {
  // Navigation
  menu: 'menu',
  close: 'close',
  back: 'chevron-back',
  forward: 'chevron-forward',
  home: 'home',
  homeOutline: 'home-outline',
  messages: 'chatbubble-ellipses',
  messagesOutline: 'chatbubble-ellipses-outline',
  settings: 'settings',
  settingsOutline: 'settings-outline',
  bell: 'notifications-outline',

  // Status and meaning
  time: 'time-outline',
  bedtime: 'moon-outline',
  calendar: 'calendar-outline',
  blocked: 'hand-left-outline',
  apps: 'grid-outline',
  globe: 'globe-outline',
  location: 'location-outline',
  shield: 'shield-checkmark',
  shieldOutline: 'shield-checkmark-outline',
  lock: 'lock-closed',
  key: 'key-outline',
  phone: 'phone-portrait-outline',
  usage: 'stats-chart-outline',

  // Actions and feedback
  check: 'checkmark-circle',
  checkOutline: 'ellipse-outline',
  warning: 'alert-circle',
  warningOutline: 'alert-circle-outline',
  refresh: 'refresh',
  send: 'send',
  sos: 'warning',
  sparkle: 'sparkles',
  heart: 'heart',
  help: 'help-circle-outline',
};

export default function Icon({ name, size = 22, color = colors.body, style }) {
  const glyph = GLYPHS[name];
  if (!glyph) return null;
  return <Ionicons name={glyph} size={size} color={color} style={style} />;
}
