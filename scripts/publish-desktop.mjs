#!/usr/bin/env node
/**
 * Publish a built Child Desktop installer so the website can hand it out and
 * installed copies can update themselves.
 *
 *   node scripts/publish-desktop.mjs --platform=windows [--target=firebase|gcs] [--dry-run]
 *
 * `firebase` is the default, because it is the host this project already
 * deploys to — no second set of credentials, and the artifacts are plain static
 * files: electron-updater's generic provider only needs
 * `<base>/child-desktop/win/latest.yml` to resolve over HTTPS. `gcs` uploads to
 * a bucket instead, for when Hosting's bandwidth stops being the right shape.
 *
 * ── Why this is a script and not a line in the README ────────────────────────
 *
 * Publishing a desktop agent is four things that must all be true together, and
 * three of them fail silently:
 *
 *   1. The artifacts exist and are the version everyone thinks they are.
 *   2. `latest.yml` is beside them. Without it every installed copy checks for
 *      updates, gets a 404, and never updates again — and nothing anywhere
 *      reports that, because a failed update check is exactly what a machine
 *      with no update available looks like from the outside.
 *   3. The checksum in `latest.yml` matches the file next to it. If it does not,
 *      electron-updater downloads the installer and then refuses to run it,
 *      forever, on every machine, in a loop.
 *   4. The API's `DESKTOP_DOWNLOAD_BASE_URL` and the build's `publish.url` point
 *      at the directory these went into. Disagreeing means downloads work and
 *      updates do not, which is the failure that takes months to notice.
 *
 * So the checks come first and the upload is the easy part. `--dry-run` runs
 * every check and uploads nothing, which is what to run before cutting a
 * release.
 */

import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, mkdir, copyFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  })
);

const PLATFORMS = {
  windows: { dir: 'apps/child-desktop/windows', prefix: 'child-desktop/win', ext: /\.exe$/ },
  mac: { dir: 'apps/child-desktop/macos', prefix: 'child-desktop/mac', ext: /\.(pkg|dmg|zip)$/ },
};

const platform = String(args.platform || 'windows').toLowerCase();
const spec = PLATFORMS[platform];
const dryRun = args['dry-run'] === 'true' || args.n === 'true';

const log = (message) => process.stdout.write(`${message}\n`);
const die = (message) => {
  process.stderr.write(`\n  ✗ ${message}\n\n`);
  process.exit(1);
};

if (!spec) die(`Unknown platform "${platform}". Use --platform=windows or --platform=mac.`);

/** The base the artifacts will be reachable at, for the final consistency check. */
const baseUrl = (args['base-url'] || process.env.DESKTOP_DOWNLOAD_BASE_URL || '').replace(/\/+$/, '');
const bucket = (args.bucket || process.env.DESKTOP_DOWNLOAD_BUCKET || '').replace(/\/+$/, '');

// ── 1. Everything agrees on the version ──────────────────────────────────────

const readJson = async (relative) => JSON.parse(await readFile(path.join(ROOT, relative), 'utf8'));

const projectPkg = await readJson(`${spec.dir}/package.json`);
const version = projectPkg.version;

/**
 * The API states the version independently — see `desktopRelease.js` for why it
 * cannot import this package.json. Parsed out rather than imported, because this
 * script runs from the repo root and the API's module is CommonJS in a workspace
 * that may not be installed.
 */
const apiRelease = await readFile(path.join(ROOT, 'services/api/src/config/desktopRelease.js'), 'utf8');
const apiVersion = apiRelease.match(/const VERSION = '([^']+)'/)?.[1];

if (apiVersion !== version) {
  die(
    `Version mismatch: ${spec.dir}/package.json is ${version}, `
    + `services/api/src/config/desktopRelease.js is ${apiVersion}.\n`
    + '    Both have to change together — the API names the file the website links to.'
  );
}
log(`  Version ${version} (build and API agree)`);

// ── 2. The artifacts are there ───────────────────────────────────────────────

const distDir = path.join(ROOT, spec.dir, 'dist');
let entries;
try {
  entries = await readdir(distDir);
} catch {
  die(`No build output at ${path.relative(ROOT, distDir)}. Run \`npm run desktop:${platform === 'mac' ? 'mac' : 'win'}\` first.`);
}

const installers = entries.filter((name) => spec.ext.test(name) && name.includes(version));
if (installers.length === 0) {
  die(
    `No ${version} installers in ${path.relative(ROOT, distDir)} — found: ${entries.join(', ') || '(nothing)'}.\n`
    + '    The build output is from a different version. Rebuild.'
  );
}

/**
 * `latest.yml` is what electron-updater fetches, and it only exists if the
 * build had a `publish` block. A release without it installs fine and then
 * never updates, which is the quietest failure in this whole pipeline.
 */
const feedFile = platform === 'mac' ? 'latest-mac.yml' : 'latest.yml';
if (!entries.includes(feedFile)) {
  die(
    `${feedFile} is missing from the build output.\n`
    + `    electron-builder writes it from the "publish" block in ${spec.dir}/package.json. `
    + 'Without it, every installed copy stops updating.'
  );
}

// ── 3. The checksum in the feed matches the file beside it ───────────────────

const sha512 = (file) => new Promise((resolve, reject) => {
  const hash = createHash('sha512');
  createReadStream(file)
    .on('error', reject)
    .on('data', (chunk) => hash.update(chunk))
    .on('end', () => resolve(hash.digest('base64')));
});

const feed = await readFile(path.join(distDir, feedFile), 'utf8');
const feedVersion = feed.match(/^version:\s*(.+)$/m)?.[1]?.trim();
if (feedVersion !== version) {
  die(`${feedFile} names version ${feedVersion}, but the build is ${version}. The build output is stale.`);
}

const feedPath = feed.match(/^path:\s*(.+)$/m)?.[1]?.trim();
const feedSha = feed.match(/^ {4}sha512:\s*(.+)$/m)?.[1]?.trim() || feed.match(/^sha512:\s*(.+)$/m)?.[1]?.trim();

if (feedPath && feedSha) {
  const target = path.join(distDir, feedPath);
  const actual = await sha512(target).catch(() => null);
  if (actual === null) {
    die(`${feedFile} points at ${feedPath}, which is not in the build output.`);
  }
  if (actual !== feedSha) {
    die(
      `Checksum mismatch for ${feedPath}.\n`
      + `    ${feedFile} says ${feedSha.slice(0, 24)}…\n`
      + `    the file hashes to ${actual.slice(0, 24)}…\n`
      + '    Every machine would download this update and then refuse to install it. Rebuild.'
    );
  }
  log(`  ${feedFile} checksum matches ${feedPath}`);
}

// ── 4. What will be uploaded ─────────────────────────────────────────────────

const uploads = [...installers, feedFile, ...entries.filter((n) => n.endsWith('.blockmap'))];

log('');
log(`  Publishing ${uploads.length} files to ${spec.prefix}/`);
for (const name of uploads) {
  const { size } = await stat(path.join(distDir, name));
  log(`    ${name}  ${(size / 1024 / 1024).toFixed(1)} MB`);
}

/**
 * The two halves have to name the same directory, and this is the check.
 *
 * `DESKTOP_DOWNLOAD_BASE_URL` is where the API sends a browser; `build.publish.url`
 * is where every *installed* agent looks for its next version. Nothing connects
 * them, and when they disagree the result is the failure that takes months to
 * notice: downloads work perfectly, and updates silently never happen — because
 * a fleet that cannot reach its feed is indistinguishable from a fleet that is
 * already up to date.
 */
const publishUrl = (projectPkg.build?.publish?.[0]?.url || '').replace(/\/+$/, '');
const expectedFeed = baseUrl ? `${baseUrl}/${spec.prefix}` : '';

if (baseUrl) {
  log('');
  log(`  Download URL  ${baseUrl}/${spec.prefix}/${installers.find((n) => !/-(x64|arm64)\./.test(n)) || installers[0]}`);
  log(`  Update feed   ${baseUrl}/${spec.prefix}/${feedFile}`);

  if (publishUrl !== expectedFeed) {
    die(
      'The download host and the update feed disagree.\n\n'
      + `    DESKTOP_DOWNLOAD_BASE_URL  ${baseUrl}\n`
      + `      → this release would be reachable at  ${expectedFeed}/\n`
      + `    ${spec.dir}/package.json "publish".url\n`
      + `      → installed copies will look for updates at  ${publishUrl}/\n\n`
      + '    Publishing like this gives you working downloads and a fleet that\n'
      + '    never updates again, with nothing anywhere reporting a problem.\n'
      + '    Change one to match the other and rebuild.'
    );
  }
  log(`  Feed matches the build's baked-in publish URL`);
} else {
  log('');
  log('  ! DESKTOP_DOWNLOAD_BASE_URL is not set, so the URLs cannot be checked');
  log('    against the feed baked into this build:');
  log(`      ${publishUrl || '(none — this build has no publish block)'}`);
  log('    Set it to the origin these files will be served from and re-run.');
}

if (dryRun) {
  log('');
  log('  Dry run — nothing published. Every check passed.');
  process.exit(0);
}

// ── 5. Publish ───────────────────────────────────────────────────────────────

const run = (command, commandArgs) => new Promise((resolve, reject) => {
  const child = spawn(command, commandArgs, { stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('error', reject);
  child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
});

const target = String(args.target || (bucket ? 'gcs' : 'firebase')).toLowerCase();

if (target === 'firebase') {
  /**
   * Prove the credential before copying 390 MB into place.
   *
   * The same preflight `deploy-web.sh` makes, for the same reason and against
   * the same failure: an expired Firebase token looks identical to a good one
   * until something asks Hosting to do work, and the error arrives as
   *
   *   Authentication Error: Your credentials are no longer valid.
   *
   * with the staging folder already written. `projects:list` is a real API call,
   * so it catches an *expired* token and not merely a missing one — which
   * `login:list` would not, since that reads the cached credential file and
   * happily reports an account Google has since stopped honouring.
   *
   * Hosting credentials are separate from gcloud's: being logged into gcloud,
   * even as the project owner, does not authenticate this.
   */
  await run('firebase', ['projects:list']).catch(() => die(
    'firebase is not authenticated (or the token has expired).\n\n'
    + '    In Cloud Shell there is no localhost callback, so:\n'
    + '      firebase login --reauth --no-localhost\n\n'
    + '    Elsewhere:\n'
    + '      firebase login --reauth\n\n'
    + '    Being logged into gcloud does not authenticate Hosting — they are\n'
    + '    separate credential stores.'
  ));

  /**
   * Staged into the shape the URLs promise, rather than deployed from `dist`.
   *
   * Firebase Hosting serves its public directory at the root, and the artifacts
   * have to live under `child-desktop/win/` so one `DESKTOP_DOWNLOAD_BASE_URL`
   * works whichever host is behind it — and so a Mac release can land beside a
   * Windows one without either moving. The staging folder is also what keeps
   * `builder-debug.yml` and the ~700 MB of unpacked build output out of a deploy
   * that would otherwise upload all of it.
   *
   * Rebuilt from empty every time. A stale installer left in here from a
   * previous version would be published again and stay downloadable for ever at
   * a URL nothing references — which is exactly how a family ends up installing
   * a build that was withdrawn.
   */
  const staging = path.join(ROOT, 'apps/child-desktop/dist-publish');
  const into = path.join(staging, spec.prefix);

  await rm(staging, { recursive: true, force: true });
  await mkdir(into, { recursive: true });
  for (const name of uploads) {
    await copyFile(path.join(distDir, name), path.join(into, name));
  }
  log('');
  log(`  Staged into ${path.relative(ROOT, into)}`);

  await run('firebase', ['deploy', '--only', 'hosting:downloads'])
    .catch((error) => die(
      `Deploy failed: ${error.message}\n\n`
      + '    If Hosting says the site does not exist, create it once:\n'
      + '      firebase hosting:sites:create parentix-downloads\n'
      + '    The target mapping is already in .firebaserc.'
    ));
} else if (target === 'gcs') {
  if (!bucket) {
    die('No destination. Pass --bucket=gs://your-bucket or set DESKTOP_DOWNLOAD_BUCKET.');
  }
  const destination = `${bucket}/${spec.prefix}/`;

  for (const name of uploads) {
    /**
     * `no-cache` on the feed, a year on the installers.
     *
     * The installers are immutable — their names carry the version — so they can
     * be cached for as long as anything will hold them. `latest.yml` is the
     * opposite: it is the same URL every release, and a CDN holding yesterday's
     * copy means yesterday's version is what every machine believes is current.
     * That is the one cache header in this repository that would break updates
     * for everyone at once. (Firebase gets the same rule from firebase.json.)
     */
    const cacheControl = name === feedFile
      ? 'no-cache, max-age=0, must-revalidate'
      : 'public, max-age=31536000, immutable';

    await run('gcloud', [
      'storage', 'cp',
      '--cache-control', cacheControl,
      path.join(distDir, name),
      destination,
    ]).catch((error) => die(`Upload failed for ${name}: ${error.message}`));
  }
} else {
  die(`Unknown --target "${target}". Use firebase or gcs.`);
}

log('');
log(`  Published ${version}`);
log('');
log('  Verify before announcing it — the second one is what a parent clicks:');
log(`    curl -sI ${baseUrl || '<base>'}/${spec.prefix}/${feedFile} | head -1`);
log(`    curl -sI ${(process.env.PARENTIX_API_URL || 'https://api.parentix.ca').replace(/\/api\/?$/, '')}/api/downloads/child-desktop/${platform}`);
log('');
log('  If the second answers 503, the API does not have DESKTOP_DOWNLOAD_BASE_URL set.');
