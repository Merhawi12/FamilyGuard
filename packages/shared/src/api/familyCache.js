/**
 * A few seconds of memory in front of `GET /children`.
 *
 * ── The problem it solves ────────────────────────────────────────────────────
 *
 * Eleven screens in the family app open by listing the children: Dashboard,
 * Children, Screen Time, App Blocking, Activity, Web History, Reports, Alerts,
 * Location, Messages, Contacts and Profile. Every one of them has to — the child
 * tabs across the top of each screen are built from it, and a parent can land on
 * any of those screens first. So the list is not redundant; the *round trip* is.
 *
 * A parent moving Dashboard → Screen Time → App Blocking → Reports made four
 * identical requests inside a few seconds, and none of them could have returned
 * anything different: children are added from one screen, by hand, a few times
 * in the life of an account. Each one is a real cost on both ends — three
 * queries and a cluster-wide socket presence lookup on the API, and on a phone
 * a fresh HTTPS request whose latency is the delay before the tabs appear and
 * the screen can ask its real question. That is what makes navigation feel slow
 * on a slow connection: not the screen's own data, but the list in front of it.
 *
 * ── Why it lives here and not in a React context ─────────────────────────────
 *
 * A provider would have to own loading and error state for all eleven screens,
 * and those screens do not agree about what a failure means — deliberately.
 * Some render "Could not load your children" ahead of the empty state, one
 * shows a partial family summary, one leaves the previous list on screen. Each
 * of those distinctions was reasoned about where it lives (an empty list and a
 * failed request must never look alike), and a shared provider would flatten
 * them.
 *
 * Caching the *request* instead leaves every call site exactly as it is —
 * `children.list().then(…).catch(…)` — and changes only whether a packet goes
 * out. Nothing above this file knows it exists.
 *
 * ── The four rules that make it safe ─────────────────────────────────────────
 *
 * 1. **A failure is never cached.** The entry is dropped before the rejection is
 *    handed on, so a screen that retries after an error really retries. Caching
 *    a failure would turn one dropped request into thirty seconds of a family
 *    app insisting the parent has no children.
 *
 * 2. **Concurrent callers share one request.** Two components mounting in the
 *    same tick — a page and its layout — get the same in-flight promise rather
 *    than racing two requests, which is a saving even at a zero-second TTL.
 *
 * 3. **Every mutation drops it.** Adding, renaming or removing a child, and
 *    every device action a parent can take, call `invalidateFamily()`. So the
 *    list is only ever reused across reads, and the screen that changed
 *    something sees the change — the staleness window applies to nothing the
 *    parent did.
 *
 * 4. **Each caller gets its own array.** The rows are shared, but the array is
 *    copied per call, so a screen that sorts or splices its copy cannot reorder
 *    another screen's list.
 *
 * ── On `online` ──────────────────────────────────────────────────────────────
 *
 * `GET /children` stamps each device with `online`, resolved from live sockets.
 * That is the one field here with a short shelf life, and the TTL is chosen
 * against it rather than against the children: `ONLINE_WINDOW_MS` on the API is
 * fifteen minutes, so a dot that is up to `TTL_MS` stale is well inside the
 * tolerance presence already has. The Children screen, which is where a parent
 * actually watches device status, reloads explicitly after every action it
 * offers.
 */

const TTL_MS = 30_000;

/** `{ at, rows }` for a settled list, or null. */
let cached = null;
/** The request currently in flight, so concurrent callers share it. */
let inFlight = null;

/**
 * Forget the cached family.
 *
 * Called by every mutating binding in endpoints.js, and safe to call from
 * anywhere else that learns the family has changed.
 */
export const invalidateFamily = () => {
  cached = null;
  inFlight = null;
};

/**
 * `GET /children`, from memory when it is fresh enough.
 *
 * Resolves to an axios-shaped `{ data }` so call sites are unchanged. Pass
 * `{ fresh: true }` to force a round trip — for a screen that has just acted, or
 * one whose whole job is to show the current state.
 *
 * @param {() => Promise<{data: any}>} request the real call
 * @param {{ fresh?: boolean }} [options]
 */
export const cachedFamily = (request, { fresh = false } = {}) => {
  if (fresh) invalidateFamily();

  if (cached && Date.now() - cached.at < TTL_MS) {
    // A copy of the array, not the array. See rule 4 above.
    return Promise.resolve({ data: [...cached.rows] });
  }

  if (!inFlight) {
    inFlight = request()
      .then((response) => {
        const rows = Array.isArray(response?.data) ? response.data : [];
        cached = { at: Date.now(), rows };
        inFlight = null;
        return rows;
      })
      .catch((error) => {
        // Never cached, and the in-flight slot is cleared before the rejection
        // travels, so the next caller starts a real request. See rule 1.
        cached = null;
        inFlight = null;
        throw error;
      });
  }

  return inFlight.then((rows) => ({ data: [...rows] }));
};

export const FAMILY_CACHE_TTL_MS = TTL_MS;
