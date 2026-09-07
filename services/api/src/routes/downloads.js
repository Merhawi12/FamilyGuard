const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const {
  getDesktopRelease,
  downloadDesktop,
  getDesktopUpdateFeed,
} = require('../controllers/downloadController');

/**
 * Public download routes — no `authenticate`, deliberately.
 *
 * The installer has to be reachable from the marketing site, from a support
 * article and from a link a parent mailed to themselves, none of which carry a
 * session. There is nothing here to protect: the artifacts are a public product
 * download, and knowing their URL gives you a copy of an agent that does
 * precisely nothing until somebody redeems a linking code against a real
 * account.
 */

/**
 * Generous, because these are redirects and manifests rather than work, and
 * because the thing being limited is a browser that may legitimately ask twice
 * (the page, then the click). Tight enough that the endpoint cannot be used to
 * make the API generate traffic against the CDN on someone else's behalf.
 */
const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many download requests, please try again shortly' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(downloadLimiter);

router.get('/child-desktop', getDesktopRelease);
router.get('/child-desktop/:platform', downloadDesktop);
router.get('/child-desktop/:platform/feed', getDesktopUpdateFeed);

module.exports = router;
