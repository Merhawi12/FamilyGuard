/**
 * Which build of the Child Desktop agent this API points people at.
 *
 * The agent is the one Parentix client that is not installed from a store, so
 * the platform has to answer two questions nobody else answers for it: *where
 * are the bytes* (the website's download button, and the "Add a computer" sheet)
 * and *is the copy already running the current one* (electron-updater's feed).
 *
 * Both answers come from here rather than from a fetch, on purpose. A download
 * button that depends on the API reaching a bucket at request time is a button
 * that breaks in a way the parent reads as "Parentix is down", and a release
 * manifest is a handful of strings that change once per release — a deploy, not
 * a runtime lookup.
 *
 * ── The one thing that must stay in step ─────────────────────────────────────
 * `VERSION` below is the version in `apps/child-desktop/windows/package.json`.
 * They are two files because the API has no business importing an Electron
 * project's package.json (it is not in the API's install tree and would not be
 * present in the container), and `desktopRelease.test.js` reads both and fails
 * when they diverge — which is the whole reason it is safe to copy the number.
 */

const path = require('node:path');

/**
 * The published build. Bumped as part of cutting a release, alongside the two
 * platform package.json files and `scripts/publish-desktop.mjs`.
 */
const VERSION = '1.0.0';

/**
 * Where the artifacts are served from.
 *
 * Deliberately one variable and not a provider abstraction: a Cloud Storage
 * bucket behind Cloud CDN, a bare GCS bucket and a GitHub release all produce
 * stable `<base>/<file>` URLs, and electron-updater's `generic` provider wants
 * exactly that shape too. Choosing between them is a deploy decision, so it is
 * spelled as a deploy variable.
 *
 * Unset means downloads are *not configured*, which the routes report as 503
 * rather than by handing out a URL that 404s. A parent who clicks a button and
 * gets a broken file has no way to tell that from a corrupt download; a page
 * that says the installer is not available yet is at least true.
 */
const baseUrl = (process.env.DESKTOP_DOWNLOAD_BASE_URL || '').replace(/\/+$/, '');

/**
 * The installers, by platform.
 *
 * **Windows defaults to the combined build, not an arch-specific one.** The
 * arch-specific installers are half the size and are offered on the download
 * page for anyone who wants one, but the button a parent clicks must not depend
 * on them knowing whether their child's laptop has an Intel or an ARM processor.
 * Getting that wrong produces an installer that refuses to run, and "this app
 * can't run on your PC" is not a message a non-technical parent can act on.
 *
 * macOS is listed with `available: false` until a build exists: the agent's
 * macOS half has never been compiled (no Mac in the build chain), and a download
 * button for a file nobody has ever produced is worse than no button.
 */
const ARTIFACTS = {
  windows: {
    platform: 'windows',
    label: 'Windows 10 and 11',
    short: 'Windows',
    available: true,
    // 64-bit Intel/AMD and ARM in one file — see above.
    file: `Parentix-Setup-${VERSION}.exe`,
    variants: [
      { arch: 'x64', label: '64-bit Intel or AMD', file: `Parentix-Setup-${VERSION}-x64.exe` },
      { arch: 'arm64', label: 'ARM (Snapdragon, Surface Pro X)', file: `Parentix-Setup-${VERSION}-arm64.exe` },
    ],
    // The directory the artifacts and electron-updater's `latest.yml` share.
    prefix: 'child-desktop/win',
  },
  mac: {
    platform: 'mac',
    label: 'macOS 12 and later',
    short: 'Mac',
    available: false,
    unavailableReason: 'The Mac installer has not been published yet.',
    file: `Parentix-${VERSION}.pkg`,
    variants: [],
    prefix: 'child-desktop/mac',
  },
};

const isConfigured = () => !!baseUrl;

/** `<base>/child-desktop/win/Parentix-Setup-1.0.0.exe`, or null when unconfigured. */
const artifactUrl = (platform, arch = null) => {
  const entry = ARTIFACTS[platform];
  if (!entry || !baseUrl) return null;
  const variant = arch ? entry.variants.find((v) => v.arch === arch) : null;
  if (arch && !variant) return null;
  return `${baseUrl}/${entry.prefix}/${variant ? variant.file : entry.file}`;
};

/**
 * The update feed base for a platform — what electron-updater is pointed at.
 *
 * It is the artifact directory rather than a file: the updater appends
 * `latest.yml` itself, reads the version and sha512 out of it, and fetches the
 * installer named there. Which means a release is published by writing files
 * into this directory and nothing has to be told about it.
 */
const updateFeedUrl = (platform) => {
  const entry = ARTIFACTS[platform];
  if (!entry || !baseUrl) return null;
  return `${baseUrl}/${entry.prefix}/`;
};

/**
 * The manifest the website and the family app read.
 *
 * Shaped for a caller that wants to render a download button without knowing
 * anything about arches or buckets: `platforms.windows.url` is the answer, and
 * `available` is the only thing worth branching on.
 */
const releaseManifest = () => ({
  version: VERSION,
  configured: isConfigured(),
  platforms: Object.fromEntries(
    Object.entries(ARTIFACTS).map(([key, entry]) => {
      // Configured *and* built. They fail for different reasons and a caller
      // that only knew "unavailable" would have to invent a sentence: no
      // artifact has ever been produced for this platform, or this deployment
      // has nowhere to serve one from. Both get a true one here, because the
      // page showing it has no way to tell them apart.
      const available = entry.available && isConfigured();
      const reason = entry.available
        ? `The ${entry.short} installer is not available from this server.`
        : entry.unavailableReason;

      return [key, {
        platform: entry.platform,
        label: entry.label,
        available,
        ...(available ? {} : { reason }),
        version: VERSION,
        url: available ? artifactUrl(key) : null,
        file: entry.file,
        variants: entry.variants.map((v) => ({
          arch: v.arch,
          label: v.label,
          url: available ? artifactUrl(key, v.arch) : null,
        })),
      }];
    })
  ),
});

/**
 * Where a locally built artifact sits, for the publish script and the tests
 * that check the manifest names a file that was actually produced.
 */
const localArtifactDir = (platform) =>
  path.join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'apps',
    'child-desktop',
    platform === 'mac' ? 'macos' : 'windows',
    'dist'
  );

module.exports = {
  VERSION,
  ARTIFACTS,
  baseUrl,
  isConfigured,
  artifactUrl,
  updateFeedUrl,
  releaseManifest,
  localArtifactDir,
};
