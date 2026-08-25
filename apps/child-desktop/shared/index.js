/**
 * @parentix/child-desktop-shared — everything both desktop platforms run.
 *
 * The Windows and macOS projects are Electron shells: they supply a platform
 * implementation (see `src/platform/contract.js`), open a window on `src/ui`,
 * and start the agent. No product behaviour lives in either of them.
 */
export { setPlatform, platform, UNSUPPORTED } from './src/platform/index.js';
export { describeCapabilities } from './src/platform/contract.js';

export * as agent from './src/services/agent.js';
export * as link from './src/services/link.js';
export * as chat from './src/services/chat.js';
export * as rules from './src/services/rules.js';
export { loadChildName } from './src/services/profile.js';
export {
  lockState, parseTimeOfDay, withinWindow, bonusMinutesFrom, minutesUntilLimit, tierFor,
} from './src/services/schedule.js';
export { API_HOST } from './src/services/api.js';
export { colors, radius, space } from './src/theme.js';
