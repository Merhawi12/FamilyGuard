/**
 * iOS entry point. Identical to ../android/index.js, and deliberately a separate
 * file rather than a shared one: `"main"` is resolved from the project root, and
 * each project is meant to stand on its own.
 *
 * This replaces `expo/AppEntry.js`, which the single-project layout used via
 * `"main"`. That file hardcodes `import App from '../../App'` — a root `App.js`
 * relative to itself inside node_modules — and there is no root `App.js` any
 * more: the component lives in the shared package both platforms build from.
 */
import { registerRootComponent } from 'expo';
import App from '@parentix/child-shared';

registerRootComponent(App);
