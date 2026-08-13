/**
 * Whether the introduction has already been shown.
 *
 * Kept beside the session rather than on the account on purpose: it is a fact
 * about this install, not about the parent. A second phone deserves the
 * introduction again, and a parent who signs out has not forgotten what the app
 * is for.
 *
 * Every read is guarded. `localStorage` throws rather than returning null in a
 * WebView with site data disabled and in Safari's private mode, and a splash
 * screen is the one place in the app where an exception costs the user
 * everything — it is the first thing that runs, so a throw here is a blank
 * launch with no way past it. Failing to "already seen" is the safe direction:
 * the worst case is that someone sees the introduction twice.
 */

const KEY = 'px_welcome_seen';

export const welcomeSeen = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return true;
  }
};

export const markWelcomeSeen = () => {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    // Storage is unavailable, so the introduction shows again next launch.
    // Annoying, and much better than refusing to leave it.
  }
};
