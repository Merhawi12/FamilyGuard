/**
 * Module resolve hook that swaps the Expo / React Native platform packages for
 * the stubs in ./stubs, so the child app's service layer can be exercised under
 * plain Node.
 *
 * Registered by scripts/e2e.mjs via `module.register`, which passes the platform
 * project to resolve libraries from — see `initialize` below.
 */
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STUBS = {
  'expo-secure-store': './stubs/expo-secure-store.mjs',
  'expo-location': './stubs/expo-location.mjs',
  'expo-task-manager': './stubs/expo-task-manager.mjs',
  'expo-background-fetch': './stubs/expo-background-fetch.mjs',
  'expo-notifications': './stubs/expo-notifications.mjs',
  'expo-device': './stubs/expo-device.mjs',
  'expo-constants': './stubs/expo-constants.mjs',
  'react-native': './stubs/react-native.mjs',
};

/**
 * Metro resolves `./api` to `api.js` and `./Screen` to `Screen.jsx`; Node's ESM
 * resolver requires the extension. Rather than pepper the app with extensions
 * that its real bundler does not need, the harness resolves them the way Metro
 * would.
 */
const EXTENSIONS = ['.js', '.jsx', '.mjs', '/index.js'];

/**
 * The project whose `node_modules` supplies the libraries, as a URL to resolve
 * bare specifiers against.
 *
 * The app source now lives in the shared package, which has no node_modules of
 * its own — every library is a peerDependency, installed by `../../android` and
 * `../../ios`. Node resolves from the importing file, so an `import axios from
 * 'axios'` inside `src/services/api.js` would look beside that file, walk up
 * through `apps/` to the repo root, and find either nothing or the wrong thing:
 * the root is where the two web apps resolve **react 18.3.1**, against React
 * Native's pinned **18.2.0**.
 *
 * So bare specifiers are anchored to the platform project instead of being
 * allowed to climb — the same rule, and for the same reason, as
 * `disableHierarchicalLookup` in the two metro.config.js files.
 */
let projectURL = null;

export function initialize({ projectRoot }) {
  // A file URL inside the project, not the directory itself: Node resolves a
  // bare specifier relative to the importing *module*, so this stands in for one.
  projectURL = pathToFileURL(path.join(projectRoot, 'package.json')).href;
}

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS[specifier];
  if (stub) {
    return { url: new URL(stub, import.meta.url).href, shortCircuit: true };
  }

  const bare = projectURL
    && !specifier.startsWith('.')
    && !specifier.startsWith('/')
    && !specifier.startsWith('file:')
    && !isBuiltin(specifier);

  if (bare) {
    // Resolved as though imported from the platform project, which honours the
    // package's `exports` map — socket.io-client ships separate ESM and CJS
    // builds, and `require.resolve` would quietly pick the wrong one.
    try {
      return await nextResolve(specifier, { ...context, parentURL: projectURL });
    } catch { /* fall through: a workspace-local package still resolves normally */ }
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
