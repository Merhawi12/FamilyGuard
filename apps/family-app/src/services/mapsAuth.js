/**
 * Notices when Google refuses the Maps key.
 *
 * There are three ways the map can fail and the page used to handle two. A
 * missing key is caught before loading, and a script that never arrives shows up
 * as `loadError`. The third is the one that happens in practice: the key is
 * present, well-formed and live, the script loads perfectly — and Google then
 * rejects it during authentication, because the key's HTTP referrer allowlist
 * does not include the host serving the page, or Maps JavaScript is not enabled
 * on the project, or billing is off.
 *
 * Nothing in the loader reports that. `loadError` stays null and `isLoaded` goes
 * true, so as far as the page is concerned the map is fine — while Google paints
 * its own grey "Oops! Something went wrong." inside the container. This is what
 * tells the Location page to draw its keyless OpenStreetMap map instead, and to
 * put the reason above it where whoever configured the key will see it.
 *
 * `window.gm_authFailure` is Google's documented hook for exactly this, and it
 * is a single global with no unsubscribe, so it is claimed once here at module
 * load rather than from an effect that could clobber or drop it on a remount.
 * The flag is sticky because the failure is: the key does not become valid again
 * without a redeploy or a change in the Cloud console.
 */

let failed = false;
const listeners = new Set();

if (typeof window !== 'undefined') {
  window.gm_authFailure = () => {
    failed = true;
    listeners.forEach((notify) => notify(true));
  };
}

/** Whether Google has already refused the key — for the initial render. */
export const mapsAuthFailed = () => failed;

/** Subscribe to the refusal. Returns an unsubscribe. */
export const onMapsAuthFailure = (notify) => {
  listeners.add(notify);
  return () => listeners.delete(notify);
};
