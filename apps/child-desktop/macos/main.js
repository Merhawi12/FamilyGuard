import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap } from '@parentix/child-desktop-shared/host';
import { createMacosPlatform } from './src/platform/index.js';

/**
 * The macOS entry point, and the whole of what makes this project macOS.
 *
 * Everything below this line is shared with Windows. The difference between the
 * two products is one import.
 */
bootstrap({
  createOs: createMacosPlatform,
  projectRoot: path.dirname(fileURLToPath(import.meta.url)),
}).catch((error) => {
  console.error('[parentix] failed to start:', error);
  process.exit(1);
});
