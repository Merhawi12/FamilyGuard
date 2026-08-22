/**
 * Metro has to be told two things once the app's own source lives outside its
 * project root, and getting either wrong fails in a way that does not name the
 * cause.
 *
 * 1. **Watch the shared package.** npm installs `@parentix/child-shared` as a
 *    symlink (`file:../shared`), so its real files sit outside this root. Metro
 *    watches the project root and `watchFolders` only — without this the bundle
 *    either fails to resolve the screens or, worse, serves a stale copy of them
 *    through a dev server that never noticed the edit.
 *
 * 2. **Never climb above this project for `node_modules`.** This is the one that
 *    cost real time. The repo root resolves **react 18.3.1** for the two web
 *    apps; React Native 0.73.6 pins **18.2.0**. Metro's default resolver walks
 *    up the directory tree, so from `../shared/src/screens/…` it can reach the
 *    root and load the wrong React — and two Reacts in one bundle is not an
 *    error, it is an "invalid hook call" crash at runtime that names no file and
 *    no package.
 *
 *    `disableHierarchicalLookup` stops the walk and `nodeModulesPaths` states
 *    the only place to look, which is this project's own install. It is also why
 *    these projects are not npm workspaces: hoisting would put the web tier's
 *    React above them again, and `npm install` refuses outright with ERESOLVE.
 */
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, '../shared');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [sharedRoot];
config.resolver.disableHierarchicalLookup = true;
config.resolver.nodeModulesPaths = [path.join(projectRoot, 'node_modules')];

module.exports = config;
