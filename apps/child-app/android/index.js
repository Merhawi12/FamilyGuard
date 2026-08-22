/**
 * Android entry point.
 *
 * This replaces `expo/AppEntry.js`, which the single-project layout used via
 * `"main"`. That file hardcodes `import App from '../../App'` — a root `App.js`
 * relative to itself inside node_modules — and there is no root `App.js` any
 * more: the component lives in the shared package both platforms build from.
 *
 * `registerRootComponent` is the whole of what AppEntry did, and it is exported
 * from `expo` for exactly this case. It wraps the component and calls
 * `AppRegistry.registerComponent('main', …)`, which is the name the native
 * MainActivity looks up.
 */
import { registerRootComponent } from 'expo';
import App from '@parentix/child-shared';

registerRootComponent(App);
