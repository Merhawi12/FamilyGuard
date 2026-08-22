import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap } from '@parentix/child-desktop-shared/host';
import { createWindowsPlatform } from './src/platform/index.js';

/**
 * The Windows entry point, and the whole of what makes this project Windows.
 *
 * ESM rather than CommonJS: Electron has loaded an ESM main process since 28,
 * this package says `"type": "module"`, and the shared package is ESM because
 * the headless test harness runs it under plain Node with no bundler. The one
 * file that cannot follow is `preload.cjs`, and it says so in its own name.
 */
bootstrap({
  createOs: createWindowsPlatform,
  projectRoot: path.dirname(fileURLToPath(import.meta.url)),
}).catch((error) => {
  console.error('[parentix] failed to start:', error);
  process.exit(1);
});
