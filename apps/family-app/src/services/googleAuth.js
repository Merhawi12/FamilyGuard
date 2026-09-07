/**
 * Sign in with Google inside the Android shell.
 *
 * The browser gets its ID token from Google Identity Services, which will not
 * run in an embedded WebView — so in the APK the same token comes from Play
 * Services through the app's own Capacitor plugin (`GoogleAuthPlugin.java`).
 * What crosses this boundary either way is one string: a JWT signed by Google,
 * posted to `POST /api/auth/google`, which is where it is actually verified.
 *
 * This module is the adapter `GoogleSignInButton` takes. It lives here rather
 * than in `packages/shared` for the reason `push.js` does: shared knows nothing
 * about Capacitor and must not start to — it is also what the admin console is
 * built from, and that ships to browsers only.
 */

/**
 * Capacitor injects this global into the WebView; a browser never has it.
 *
 * Checked before `@capacitor/core` is imported at all, so the web build never
 * pulls the runtime into a bundle that has no bridge to talk to.
 */
const inNativeShell = () => {
  try {
    return !!window.Capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
};

/**
 * The plugin proxy, looked up once.
 *
 * `registerPlugin` is what routes a call to the native side, and
 * `isPluginAvailable` is what says whether there is a native side to route to —
 * it reads the bridge's list of registered plugins, so it answers false on iOS
 * and in any build where `MainActivity` does not register this plugin. Without
 * that check the proxy still exists and rejects with "not implemented" on tap,
 * which is the dead button all of this exists to avoid.
 *
 * ## Why the proxy is kept in a variable and never returned
 *
 * `registerPlugin` hands back a `Proxy` that answers *every* property read with
 * a native method wrapper — `then` included. That makes it look like a thenable
 * to the language itself, so resolving any promise with it (returning it from an
 * `async` function is enough) makes the runtime call `GoogleAuth.then()` on the
 * native side to await it. There is no such method, the bridge rejects with
 * `"GoogleAuth.then()" is not implemented on android`, and the rejection lands
 * on the code that was merely trying to *obtain* the plugin — so the button
 * silently decides the device cannot sign in and never draws. It did exactly
 * that, and the only trace was one console line.
 *
 * `ensurePlugin` therefore resolves with nothing and the proxy is read from
 * module scope afterwards.
 */
let plugin = null;
let lookup = null;
const ensurePlugin = () => {
  if (!lookup) {
    lookup = (async () => {
      if (!inNativeShell()) return;
      const { Capacitor, registerPlugin } = await import('@capacitor/core');
      if (!Capacitor.isPluginAvailable('GoogleAuth')) return;
      plugin = registerPlugin('GoogleAuth');
    })().catch(() => { /* no bridge, no plugin — `plugin` stays null */ });
  }
  return lookup;
};

/**
 * Whether this device can finish a Google sign-in.
 *
 * Two questions, both answered natively: is a server client ID compiled in, and
 * does this handset have Play Services. A phone without them — some tablets,
 * anything sold outside Google's ecosystem — cannot show the account chooser at
 * all, and is shown the email form instead of a button that cannot work.
 *
 * Any failure answers false. This decides whether to *offer* something, so
 * "we could not tell" and "no" lead to the same place.
 */
export const available = async () => {
  await ensurePlugin();
  if (!plugin) return false;
  try {
    const result = await plugin.isAvailable();
    return !!result?.available;
  } catch {
    return false;
  }
};

/**
 * Opens the chooser and resolves with the ID token — or with `null` if the
 * parent closed it without choosing.
 *
 * A dismissed chooser resolving rather than throwing is the adapter's contract,
 * not a swallowed error: changing your mind is a normal outcome and must leave
 * nothing red on the screen, and expressing that as a rejection means every
 * caller has to know which rejections are not failures. Only a genuine failure
 * throws, and then there is something worth saying.
 *
 * The plugin's codes arrive on `err.code` — Capacitor puts the second argument
 * of `call.reject` there. `no-credential` is here too: a chooser that closed
 * with no account picked is the same non-event as one that was cancelled.
 */
export const signIn = async () => {
  await ensurePlugin();
  if (!plugin) throw new Error('Google sign-in is not available in this app');

  let result;
  try {
    result = await plugin.signIn();
  } catch (err) {
    if (err?.code === 'cancelled' || err?.code === 'no-credential') return null;
    /**
     * Play Services describes its own failures, and its words are for whoever
     * built the app: the one this will produce most often is "[28434] Developer
     * console is not set up correctly", which is exactly right and names an
     * OAuth client the parent has never heard of. It goes to the console, where
     * the person who can act on it is looking, and the screen is told the one
     * thing a parent can do about it. Same rule as the SMS delivery notice.
     */
    console.warn('Google sign-in failed', err?.code, err?.message);
    throw new Error('Google sign-in is not working in this app. Please sign in with your email address instead.');
  }

  if (!result?.idToken) throw new Error('Google did not return a credential');
  return result.idToken;
};

/** The shape `GoogleSignInButton` expects. */
export default { available, signIn };
