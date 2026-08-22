/**
 * Metro has to be told two things once the app's own source lives outside its
 * project root, and getting either wrong fails in a way that does not name the
 * cause. See ../android/metro.config.js — the reasoning is the same on both
 * platforms, and the file is duplicated rather than shared because a Metro
 * config is resolved from the project root and each project stands on its own.
 *
 * 1. **Watch the shared package.** npm installs `@parentix/child-shared` as a
 *    symlink (`file:../shared`), so its real files sit outside this root.
 *
 * 2. **Never climb above this project for `node_modules`.** The repo root
 *    resolves react 18.3.1 for the two web apps; React Native 0.73.6 pins
 *    18.2.0. Two Reacts in one bundle is not an error — it is an "invalid hook
 *    call" crash at runtime that names no file and no package.
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
