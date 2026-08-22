#!/usr/bin/env node
/**
 * Makes `expo export:embed` work on Windows. No-op everywhere else.
 *
 * ── The bug ──────────────────────────────────────────────────────────────────
 *
 * Gradle's `:app:createBundleReleaseJsAndAssets` fails with:
 *
 *   ENOENT: no such file or directory, mkdir
 *   '…\.expo\metro\externals\node:sea'
 *
 * `@expo/cli` writes one shim directory per Node standard-library module into
 * `.expo/metro/externals`, named after the module. Its list comes from
 * `module.builtinModules`, filtered to drop anything containing a `/`:
 *
 *   .filter((x) => !/^_|^(internal|v8|node-inspect)\/|\//.test(x) && …)
 *
 * That filter predates the builtins that are reachable *only* through the
 * `node:` prefix. Node 24 reports four — `node:sea`, `node:sqlite`, `node:test`
 * and `node:test/reporters` — and only the last is dropped, by the `/` rule. The
 * other three arrive as directory names containing a colon, which NTFS reads as
 * an alternate-data-stream separator rather than a character in a filename, so
 * the mkdir fails and the bundle step dies.
 *
 * It is Windows-only: a colon is a perfectly ordinary filename character on
 * Linux and macOS, so EAS and CI have never seen this.
 *
 * ── Why it looked fine for so long ───────────────────────────────────────────
 *
 * The shim is only written when it does not already exist, and Gradle caches the
 * bundle task. A tree with a warm `.expo` and a warm `android/app/build` never
 * runs the code above, so the failure appears only on a clean build — which is
 * exactly when someone is least expecting a toolchain bug and most likely to
 * blame whatever they last changed.
 *
 * ── What this does ───────────────────────────────────────────────────────────
 *
 * Adds `:` to that filter, in the installed copy of `@expo/cli`. Dropping those
 * three modules costs nothing: they are Node built-ins that cannot be imported
 * from a React Native bundle in any case — the shim exists so that a `require`
 * of one fails with a readable message instead of a resolver error.
 *
 * Idempotent, and silent when there is nothing to do. Run from each child app's
 * `postinstall`, so a fresh `npm install` on Windows produces a buildable tree
 * rather than one that fails at the last step of a ten-minute Gradle run.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const TARGET = 'node_modules/@expo/cli/build/src/start/server/metro/externals.js';

// The filter as shipped, and the same filter with colons excluded. Matched as a
// literal rather than by regex: if a future @expo/cli changes this line, the
// match fails, nothing is written, and the patch reports that it no longer
// applies — which is the right outcome. Silently rewriting code that has moved
// on is how a patch becomes a bug of its own.
const SHIPPED = '.filter((x)=>!/^_|^(internal|v8|node-inspect)\\/|\\//.test(x) && ![';
const PATCHED = '.filter((x)=>!/^_|^(internal|v8|node-inspect)\\/|\\/|:/.test(x) && ![';

const file = path.resolve(process.cwd(), TARGET);

if (process.platform !== 'win32') process.exit(0);
if (!existsSync(file)) process.exit(0);

const source = readFileSync(file, 'utf8');

if (source.includes(PATCHED)) process.exit(0);

if (!source.includes(SHIPPED)) {
  console.warn(
    '[patch-expo-windows] @expo/cli no longer has the filter this patches. '
    + 'If `expo export:embed` fails with a colon in an mkdir path, see this script.'
  );
  process.exit(0);
}

writeFileSync(file, source.replace(SHIPPED, PATCHED));
console.log('[patch-expo-windows] dropped colon-named Node builtins from the Metro externals list');
