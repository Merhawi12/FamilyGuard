/**
 * The marketing pages live in `public/`, are copied verbatim by Vite, and are
 * reached through a *rewrite* rather than by their own filename. That rewrite is
 * declared in three places that cannot see each other, and this is what keeps
 * them in step.
 *
 *   firebase.json                    production
 *   apps/family-app/vite.config.js   `npm run dev`
 *   scripts/browser-e2e.mjs          the browser harness
 *
 * ── Why this needs a test at all ─────────────────────────────────────────────
 *
 * Because the failure is silent and one-directional. Firebase Hosting's last
 * rule is `** → /app.html`, and so are the equivalents in the other two. A page
 * with no rewrite therefore does not 404 — the request is answered by the SPA
 * shell, with HTTP 200, and the visitor lands on the Parentix app. Somebody
 * clicking "Download" gets the dashboard, which reads as a broken button rather
 * than a missing rewrite, and nothing anywhere reports an error.
 *
 * That is exactly how `/download` shipped linked-but-unreachable in dev: the
 * production rewrite was added, the dev one was not, and both environments
 * returned 200 for the URL.
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '../../..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

const firebase = JSON.parse(read('firebase.json'));
const viteConfig = read('apps/family-app/vite.config.js');
const harness = read('scripts/browser-e2e.mjs');
const publicDir = path.join(REPO, 'apps/family-app/public');

/** The family site's rewrites, in order, as `{ source, destination }`. */
const familyRewrites = firebase.hosting.find((h) => h.target === 'family').rewrites;

/** Every rewrite that points at a real page rather than at the SPA shell. */
const pageRewrites = familyRewrites.filter((r) => r.destination !== '/app.html');

describe('the static marketing pages are reachable', () => {
  it('every rewrite points at a page that exists', () => {
    for (const { source, destination } of pageRewrites) {
      expect(fs.existsSync(path.join(publicDir, destination))).toBe(
        true,
        `${source} → ${destination}, which is not in apps/family-app/public`
      );
    }
  });

  /*
   * `/` is special — it is rewritten but has no pretty URL to keep in step, and
   * it is handled by its own line in both the dev middleware and the harness.
   */
  const prettyUrls = pageRewrites.filter((r) => r.source !== '/');

  it('has more than one pretty URL, so the sweep below means something', () => {
    expect(prettyUrls.length).toBeGreaterThanOrEqual(2);
  });

  it.each(prettyUrls.map((r) => [r.source, r.destination]))(
    '%s is rewritten in dev as well as in production',
    (source, destination) => {
      // The dev middleware carries them in a STATIC_PAGES map.
      expect(viteConfig).toContain(`'${source}': '${destination}'`);
    }
  );

  it.each(prettyUrls.map((r) => [r.source, r.destination]))(
    '%s is rewritten in the browser harness too',
    (source, destination) => {
      expect(harness).toContain(`['${source}', '${destination}']`);
    }
  );

  /*
   * And the other direction: a page sitting in `public/` that nothing routes to.
   * It is still reachable at `/thing.html`, so this is a warning about a page
   * that was added and then never linked, not a broken deployment.
   */
  it('every marketing page has a route, or is deliberately filename-only', () => {
    const FILENAME_ONLY = new Set([
      // The SPA shell. Reached through the `**` rule, never by name.
      'app.html',
      // Rewritten from `/`, and asserted above.
      'landing.html',
    ]);

    const pages = fs.readdirSync(publicDir).filter((f) => f.endsWith('.html'));
    const routed = new Set(pageRewrites.map((r) => r.destination.replace(/^\//, '')));

    for (const page of pages) {
      if (FILENAME_ONLY.has(page)) continue;
      expect(routed.has(page)).toBe(true, `${page} has no rewrite in firebase.json`);
    }
  });
});

describe('the download page is wired to the download endpoint', () => {
  const download = read('apps/family-app/public/download.html');

  /*
   * The page is static and lives outside the `src/` tree, so `VITE_API_URL`
   * never reaches it — the origin is stamped into a meta tag at build time. A
   * page that called a relative `/api/...` would be answered by Hosting's `**`
   * rule with app.html and HTTP 200, the JSON parse would fail, the catch would
   * run, and the page would report the download as unavailable on a day when it
   * was not. Exactly the bug the contact form shipped with; see
   * `contactFormOrigin.test.js`.
   */
  it('reads the API origin from the stamped meta tag', () => {
    expect(download).toMatch(/<meta name="parentix-api" content="" \/>/);
    expect(download).toContain('meta[name="parentix-api"]');
  });

  it('never calls the API on a relative path', () => {
    // Every fetch must be built from apiOrigin(). A bare '/api/...' string is
    // the tell.
    expect(download).not.toMatch(/fetch\(\s*['"`]\/api\//);
    expect(download).toContain("apiOrigin() + '/api/downloads/child-desktop'");
  });

  /*
   * The button links to the endpoint, not to the artifact URL the manifest also
   * carries. Both point at the same file today; only the endpoint keeps pointing
   * at the current one after the next release, which matters because this href
   * ends up in bookmarks and support articles nobody comes back to edit.
   */
  it('links to the versionless endpoint rather than the artifact', () => {
    expect(download).toContain("button.href = base + '/windows'");
  });

  it('is stamped by the build alongside the other static pages', () => {
    expect(viteConfig).toContain("'download.html'");
    expect(read('scripts/deploy-web.sh')).toContain('download.html');
  });
});
