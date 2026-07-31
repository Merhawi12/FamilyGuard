/**
 * Module resolve hook that swaps the Expo / React Native platform packages for
 * the stubs in ./stubs, so the child app's service layer can be exercised under
 * plain Node. Everything else — axios, socket.io-client, and the app's own
 * modules — resolves normally.
 *
 * Registered by scripts/e2e.mjs via `module.register`.
 */
const STUBS = {
  'expo-secure-store': './stubs/expo-secure-store.mjs',
  'expo-location': './stubs/expo-location.mjs',
  'expo-task-manager': './stubs/expo-task-manager.mjs',
  'expo-background-fetch': './stubs/expo-background-fetch.mjs',
  'react-native': './stubs/react-native.mjs',
};

/**
 * Metro resolves `./api` to `api.js` and `./Screen` to `Screen.jsx`; Node's ESM
 * resolver requires the extension. Rather than pepper the app with extensions
 * that its real bundler does not need, the harness resolves them the way Metro
 * would.
 */
const EXTENSIONS = ['.js', '.jsx', '.mjs', '/index.js'];

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS[specifier];
  if (stub) {
    return { url: new URL(stub, import.meta.url).href, shortCircuit: true };
  }

  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    if (!relative || !context.parentURL) throw err;

    for (const ext of EXTENSIONS) {
      try {
        return await nextResolve(specifier + ext, context);
      } catch { /* try the next extension */ }
    }
    throw err;
  }
}
