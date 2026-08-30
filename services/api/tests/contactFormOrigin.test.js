/**
 * The marketing pages must not post their contact form to a relative `/api`.
 *
 * This is the check that was missing when every contact-form submission from
 * parentix.ca was silently discarded for weeks. `landing.html` and
 * `contact.html` live in `apps/family-app/public/`, so vite copies them verbatim
 * and `VITE_API_URL` never reaches them. A relative `fetch('/api/contact')` is
 * correct in two of the three environments — the vite dev proxy serves it, and
 * `scripts/browser-e2e.mjs` proxies `/api` itself — which is exactly why nothing
 * caught it. In production firebase.json has no `/api` rewrite, so Hosting's
 * `**` rewrite answered the POST with `app.html` and **HTTP 200**. The form read
 * that as success: `res.json()` threw on HTML, the throw was swallowed to `{}`,
 * `res.ok` was true, and the visitor was thanked for a message that never left
 * their browser.
 *
 * No browser test can catch this, because the harness is one of the two
 * environments where the bug does not reproduce. So it is asserted on the source
 * text, along with the coupling that makes the fix work: `deploy-web.sh` stamps
 * the origin in with a `sed`, and that `sed` and the tag in the HTML have to
 * agree exactly or the substitution silently does nothing.
 */
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '../../../apps/family-app/public');
const DEPLOY_WEB = path.join(__dirname, '../../../scripts/deploy-web.sh');
const PAGES = ['landing.html', 'contact.html'];

const read = (file) => fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
const deployScript = fs.readFileSync(DEPLOY_WEB, 'utf8');

describe.each(PAGES)('%s', (page) => {
  const source = read(page);

  it('declares the API origin as a meta tag', () => {
    expect(source).toMatch(/<meta name="parentix-api" content="" *\/>/);
  });

  it('does not fetch a relative /api path', () => {
    // The production failure exactly: Hosting answers it with the SPA shell.
    expect(source).not.toMatch(/fetch\(\s*['"`]\/api\//);
  });

  it('builds the request from the meta tag', () => {
    expect(source).toMatch(/fetch\(\s*apiOrigin\(\)\s*\+\s*['"`]\/api\/contact['"`]/);
    expect(source).toMatch(/meta\[name="parentix-api"\]/);
  });

  /**
   * A success message must depend on the server having answered as the server.
   *
   * `res.ok` alone is what let a 200 full of HTML read as a delivered message.
   * The reference is the stored row's id, so requiring it in the success path
   * would be the stronger guarantee still — but at minimum the response has to
   * have been parsed and checked.
   */
  it('refuses a response that is not ok', () => {
    expect(source).toMatch(/if\s*\(\s*!res\.ok\s*\)\s*throw/);
  });
});

/**
 * The stamping is a build step, not a deploy step, and that is the point.
 *
 * There are two deploy paths — `scripts/deploy-web.sh` and
 * `.github/workflows/deploy-web.yml`, which runs `npm run build` and publishes
 * the output itself without ever calling that script. A fix in either one alone
 * would leave the other shipping a page whose contact form goes nowhere, which
 * is exactly how one fix for this bug would have looked complete and not been.
 */
const VITE_CONFIG = path.join(__dirname, '../../../apps/family-app/vite.config.js');
const GH_WORKFLOW = path.join(__dirname, '../../../.github/workflows/deploy-web.yml');
const viteConfig = fs.readFileSync(VITE_CONFIG, 'utf8');
const workflow = fs.readFileSync(GH_WORKFLOW, 'utf8');

describe('the origin is stamped by the build', () => {
  it('registers the plugin for the hosted build', () => {
    expect(viteConfig).toMatch(/name: 'stamp-api-origin'/);
    expect(viteConfig).toMatch(/shellAsAppHtml, stampApiOrigin\]/);
  });

  it('throws rather than silently leaving a page unstamped', () => {
    expect(viteConfig).toMatch(/could not stamp the API origin/);
  });

  /**
   * The coupling worth pinning: the plugin's regex and the tag in the HTML.
   *
   * Reformat either side — a quote style, the self-closing slash, the spacing —
   * and the replace matches nothing. Applying the plugin's actual pattern to the
   * actual file is the only honest way to assert the two agree.
   */
  it.each(PAGES)('its pattern really replaces the tag in %s', (page) => {
    const API_URL = 'https://api.parentix.ca';
    const stamped = read(page).replace(
      /<meta name="parentix-api" content="" *\/>/,
      `<meta name="parentix-api" content="${API_URL}" />`
    );
    expect(stamped).toContain(`<meta name="parentix-api" content="${API_URL}" />`);
    expect(stamped).not.toMatch(/<meta name="parentix-api" content="" *\/>/);
  });
});

describe('both deploy paths refuse an unstamped page', () => {
  it('scripts/deploy-web.sh checks the built output', () => {
    expect(deployScript).toMatch(/assert_api_origin_stamped "\$DIST"/);
    const fn = deployScript.slice(deployScript.indexOf('assert_api_origin_stamped() {'));
    expect(fn).toMatch(/silently discarded/);
    expect(fn).toMatch(/landing\.html contact\.html/);
  });

  it('the GitHub workflow checks it too, and has the origin in scope to do so', () => {
    // The grep lives inside a double-quoted shell string in YAML, so the quotes
    // around the attribute are backslash-escaped in the file itself.
    expect(workflow).toMatch(/name=\\?"parentix-api\\?" content=/);
    expect(workflow).toMatch(/silently discarded/);
    // The check greps for `${VITE_API_URL}`, which is only set on steps that
    // declare it — the layout step did not, so the check would have compared
    // against an empty string and passed on anything.
    const step = workflow.slice(workflow.indexOf('Family App output is laid out'));
    expect(step.slice(0, step.indexOf('- name: Authenticate'))).toMatch(/VITE_API_URL: \$\{\{ vars\.API_URL \}\}/);
  });
});
