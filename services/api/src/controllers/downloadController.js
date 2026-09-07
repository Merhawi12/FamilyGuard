const { releaseManifest, artifactUrl, updateFeedUrl, isConfigured, VERSION } = require('../config/desktopRelease');
const logger = require('../utils/logger');

/**
 * Handing out the Child Desktop installer.
 *
 * These are the only unauthenticated routes in the product that exist to be hit
 * from a marketing page, and the shape follows from that: they answer to a
 * browser that arrived from a button, so a failure has to be a page a parent can
 * read, not a JSON body they will never see.
 *
 * **Nothing is proxied.** The 302 sends the browser at the bucket or CDN
 * directly. Streaming a 190 MB installer through the API would put every
 * download on a Cloud Run instance's clock — the request outlives the request
 * timeout on a slow connection, the instance cannot serve anything else
 * meanwhile, and the concurrency limit turns a busy day into an outage on the
 * *whole API*, sign-in included. A redirect costs a few hundred bytes and hands
 * the transfer to infrastructure built for it.
 */

/** GET /api/downloads/child-desktop — the manifest the website and app read. */
const getDesktopRelease = (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(releaseManifest());
};

/**
 * The 503 body, shared by both redirect routes.
 *
 * Answering with an error rather than a plausible URL is the point. An
 * unconfigured deployment that redirected anyway would send the parent to a
 * 404 they would read as a corrupt download, and they would try again.
 */
const notPublished = (res, platform, reason) => {
  logger.warn('Desktop download requested but not published', { platform, reason });
  return res.status(503).json({
    error: reason,
    platform,
    version: VERSION,
  });
};

/**
 * GET /api/downloads/child-desktop/:platform — 302 to the installer.
 *
 * `?arch=x64|arm64` picks a smaller single-architecture build; without it the
 * combined installer is served, which is what the website's button links to.
 * See `desktopRelease.js` for why that is the default.
 *
 * This is the URL that goes in documentation, in the family app, and on the
 * download page, precisely *because* it does not name a version: a parent who
 * bookmarked it, or a support article written a year ago, still gets the current
 * installer.
 */
const downloadDesktop = (req, res) => {
  const platform = String(req.params.platform || '').toLowerCase();
  const manifest = releaseManifest();
  const entry = manifest.platforms[platform];

  if (!entry) {
    return res.status(404).json({ error: 'Unknown platform', platform });
  }
  if (!isConfigured()) {
    return notPublished(res, platform, 'Downloads are not configured on this server.');
  }
  if (!entry.available) {
    return notPublished(res, platform, entry.reason || 'That installer has not been published yet.');
  }

  const arch = req.query.arch ? String(req.query.arch).toLowerCase() : null;
  const url = artifactUrl(platform, arch);
  if (!url) {
    return res.status(404).json({ error: 'Unknown architecture', platform, arch });
  }

  // 302, not 301. The target carries the version number, so a permanent redirect
  // would have browsers pinning the *next* release's button to this release's
  // file — cached in a place neither we nor the parent can clear.
  res.set('Cache-Control', 'no-store');
  return res.redirect(302, url);
};

/**
 * GET /api/downloads/child-desktop/:platform/feed — where the agent checks for updates.
 *
 * The installed agent could be built with the feed URL baked in, and it is; this
 * exists so a build can *discover* it instead. That matters for exactly one
 * situation, which is the one that cannot be fixed by shipping a new build:
 * moving the artifacts to a different host. A copy that only knows a dead URL
 * can never update itself again.
 */
const getDesktopUpdateFeed = (req, res) => {
  const platform = String(req.params.platform || '').toLowerCase();
  const url = updateFeedUrl(platform);
  if (!url) {
    return notPublished(res, platform, 'Updates are not configured on this server.');
  }
  res.set('Cache-Control', 'public, max-age=300');
  return res.json({ platform, version: VERSION, feedUrl: url });
};

module.exports = { getDesktopRelease, downloadDesktop, getDesktopUpdateFeed };
