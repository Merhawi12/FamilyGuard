/**
 * Module resolve hook that anchors bare specifiers to the platform project.
 *
 * The agent lives in the shared package, which deliberately has no
 * `node_modules` of its own — every library is a peerDependency, installed by
 * `../../windows` or `../../macos`. Node resolves an import from the importing
 * *file*, and npm links `file:` dependencies as symlinks whose real path is
 * followed, so an `import axios from 'axios'` inside `src/services/api.js` looks
 * beside that file and walks up through `apps/` to the repo root — where the two
 * web apps resolve their own dependency tree, and where a version match would be
 * luck rather than intent.
 *
 * So bare specifiers are resolved as though imported from the platform project.
 * Same rule, and the same reason, as `disableHierarchicalLookup` in the child
 * app's two `metro.config.js` files.
 *
 * Registered by `scripts/e2e.mjs` via `module.register`.
 */
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let projectURL = null;

export function initialize({ projectRoot }) {
  // A file URL *inside* the project, not the directory itself: Node resolves a
  // bare specifier relative to the importing module, so this stands in for one.
  projectURL = pathToFileURL(path.join(projectRoot, 'package.json')).href;
}

export async function resolve(specifier, context, nextResolve) {
  const bare = projectURL
    && !specifier.startsWith('.')
    && !specifier.startsWith('/')
    && !specifier.startsWith('file:')
    && !isBuiltin(specifier);

  if (bare) {
    try {
      // Resolved through the project's own `exports` map — socket.io-client
      // ships separate ESM and CJS builds, and picking by hand gets it wrong.
      return await nextResolve(specifier, { ...context, parentURL: projectURL });
    } catch { /* fall through: a workspace-local package still resolves normally */ }
  }

  return nextResolve(specifier, context);
}
