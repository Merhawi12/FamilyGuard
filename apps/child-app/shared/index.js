/**
 * What `../android` and `../ios` mount. Each platform project's `index.js` hands
 * this to `registerRootComponent`; nothing else about the app differs between
 * them at the JS layer, which is the whole reason this package exists.
 */
export { default } from './App';
