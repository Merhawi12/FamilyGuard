/**
 * Linking this computer without anybody typing anything.
 *
 * The manual path — a parent reads eight characters off their dashboard and the
 * child types them into the link screen — works and is not going anywhere; it is
 * the only path that survives the parent setting the laptop up from a different
 * room, and it is the fallback for everything below. But it is also the step the
 * whole install is judged on, because it is the first one where a parent can be
 * *wrong*: a transposed character produces "That code was not recognised", which
 * reads as "this product does not work" rather than "try again".
 *
 * So the browser hands the code over directly. The parent is already on the
 * child's computer with the family app open (that is where they clicked
 * Download); the sheet that shows the code also has a button pointing at
 * `parentix://link/A1B2C3D4`, Windows hands that to this application, and the
 * agent links itself.
 *
 * ── Why a URL scheme and not something cleverer ──────────────────────────────
 *
 * The tempting alternative is to bake the code into the installer — stamp it
 * into the download's filename, have the installer recover it, and link with
 * nobody clicking anything at all. It was not built, for two reasons worth
 * writing down so it is not re-proposed as an oversight:
 *
 *   - It requires the API to serve the installer bytes so it can set a
 *     `Content-Disposition`, which is exactly the 190 MB-through-Cloud-Run
 *     problem `downloadController.js` exists to avoid.
 *   - Browsers rename collisions (`… (1).exe`), corporate proxies rewrite
 *     downloads, and "Save link as" lets the parent name the file. Each of those
 *     silently produces an installer that links nothing, on a path with no way
 *     to report that it did not work.
 *
 * A URL scheme is one extra click, is what Zoom and Slack and every OAuth
 * desktop client already do, and fails *visibly* — a browser that cannot open
 * `parentix://` says so, and the code is still on screen to type.
 *
 * ── What is trusted here, and what is not ────────────────────────────────────
 *
 * Nothing. A `parentix://` URL can be fired by any web page the child visits, so
 * this module treats an inbound code as a string a stranger chose. It is
 * validated to the code format and handed to the ordinary link call, which is
 * the same unauthenticated `POST /devices/confirm` the manual path uses — an
 * endpoint that already refuses an unknown code, an expired one, a redeemed one,
 * and one belonging to a suspended account. The worst a hostile page can do is
 * link this computer to an account that generated a code within the last 30
 * minutes and knows its value, which is the same thing it could do by showing
 * the child a code and asking them to type it.
 *
 * A computer that is *already linked* ignores inbound codes entirely — see
 * `handleSetupUrl`. Otherwise a page could re-link a monitored laptop onto an
 * attacker's account and out of its parent's, which is the one thing in this
 * file that would actually matter.
 */

/** The scheme registered with the OS. Matches `protocols` in both build configs. */
export const PROTOCOL = 'parentix';

/**
 * The linking code, as the API mints it: 8 hex characters, upper case.
 *
 * Matched strictly rather than "whatever is after the slash". The value goes
 * straight into a POST body and the error a loose match produces is the useless
 * kind — the server refuses something the child can see is a code, and nothing
 * on screen explains that it arrived with a trailing newline from a copy-paste.
 */
const CODE_PATTERN = /^[0-9A-F]{8}$/;

/** `--parentix-link=A1B2C3D4`, which is how the installer's "launch now" passes one. */
const ARG_PREFIX = '--parentix-link=';

/**
 * Pull a linking code out of anything the OS might hand us.
 *
 * Accepts all three shapes the family app or a support article could produce,
 * because which one gets used is not this module's decision:
 *
 *   parentix://link/A1B2C3D4      the button in the family app
 *   parentix://link?code=A1B2C3D4 the same thing, if a router ever prefers it
 *   parentix://A1B2C3D4           the short form somebody will inevitably write
 *
 * Returns null for anything else, including a well-formed URL of ours carrying a
 * malformed code — there is nothing useful to do with `parentix://link/hello`,
 * and passing it on would put a server error on screen for a link the child
 * never clicked.
 */
export function parseSetupUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw.toLowerCase().startsWith(`${PROTOCOL}://`)) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  // `new URL('parentix://link/A1B2C3D4')` puts `link` in `host` and `/A1B2C3D4`
  // in `pathname` — a non-special scheme is still parsed with authority rules.
  const fromQuery = url.searchParams.get('code');
  const segments = [url.hostname, ...url.pathname.split('/')]
    .map((part) => decodeURIComponent(part || '').trim())
    .filter(Boolean);

  const candidates = [fromQuery, ...segments.filter((s) => s.toLowerCase() !== 'link')];

  for (const candidate of candidates) {
    const code = String(candidate || '').trim().toUpperCase();
    if (CODE_PATTERN.test(code)) return code;
  }
  return null;
}

/**
 * The same, for a process argv — which is where a URL arrives on Windows.
 *
 * Windows does not have an `open-url` event: it re-launches the executable with
 * the URL appended as an argument, and Electron surfaces that to the *first*
 * instance through `second-instance`. So both entry points end up scanning an
 * argument list, and both come through here.
 */
export function parseSetupArgs(argv = []) {
  for (const arg of argv) {
    if (typeof arg !== 'string') continue;

    if (arg.startsWith(ARG_PREFIX)) {
      const code = decodeURIComponent(arg.slice(ARG_PREFIX.length)).trim().toUpperCase();
      if (CODE_PATTERN.test(code)) return code;
      continue;
    }

    const fromUrl = parseSetupUrl(arg);
    if (fromUrl) return fromUrl;
  }
  return null;
}

/**
 * Register `parentix://` with the OS, so a click in the browser reaches us.
 *
 * In development the executable is Electron itself, and Electron has to be told
 * which script to re-launch with or the registration points at a bare Electron
 * that shows a blank window. The packaged app needs neither argument.
 *
 * Best-effort by design: this writes to the registry on Windows, a locked-down
 * machine can refuse, and the consequence is that one convenience button does
 * nothing while the typed code still works. That is not worth failing a startup
 * over, and it is not worth a dialog either — the parent has the code on screen.
 */
export function registerProtocol(app, { argv = process.argv } = {}) {
  try {
    if (app.isPackaged) return app.setAsDefaultProtocolClient(PROTOCOL);
    // argv[1] is the script Electron was pointed at; without it a dev
    // registration resolves to `electron.exe` with no entry point.
    const args = argv[1] ? [require('node:path').resolve(argv[1])] : [];
    return app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, args);
  } catch {
    return false;
  }
}

/**
 * Wire up every way a setup URL can arrive, and call back with the code.
 *
 * @param {object} deps
 * @param {import('electron').App} deps.app
 * @param {(code: string) => void} deps.onCode  called with a validated code
 * @returns {string|null} a code present in this process's own argv, if any —
 *   the cold-start case, where the app was launched *by* the URL and there is no
 *   event to wait for.
 */
export function watchSetupUrls({ app, onCode }) {
  const deliver = (code) => {
    if (code) onCode(code);
  };

  // macOS: a running app is handed the URL as an event.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    deliver(parseSetupUrl(url));
  });

  // Windows: a second launch is collapsed into the running instance, and the
  // URL is in the argv that second launch was given.
  app.on('second-instance', (_event, argv) => {
    deliver(parseSetupArgs(argv));
  });

  return parseSetupArgs(process.argv);
}
