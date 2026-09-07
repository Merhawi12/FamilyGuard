import { useEffect, useState } from 'react';
import { API_BASE_URL, Icon } from '@parentix/shared';

/**
 * Setting up a Windows or Mac computer, in the sheet that just made a code.
 *
 * A phone and a laptop are the same product and a different chore, and this
 * component exists because pretending otherwise is where parents get stranded.
 * Linking a phone is: hand the child the phone, they have the app, type eight
 * characters. Linking a laptop is: get the software onto a machine that has
 * none, and *then* type eight characters. The code alone answers the second half
 * of a job whose first half the parent has not been told about.
 *
 * So the order here is the order of the work — download, install, connect — and
 * the code, which is the last step, is shown last. A sheet that opened on the
 * code would be answering the question the parent has in ten minutes' time.
 *
 * ── The two situations, and why both buttons are here ────────────────────────
 *
 * **The parent is at the child's computer.** The common case, and the one worth
 * optimising: they are signed in to Parentix in a browser on the machine being
 * set up. Download, install, and then "Connect this computer" hands the code
 * straight to the freshly installed agent over the `parentix://` scheme. Nobody
 * types anything.
 *
 * **The parent is somewhere else.** Their own laptop, their phone, the kitchen.
 * The download button is then the wrong machine and the connect button does
 * nothing useful — so the code is always shown, in full, with the instruction to
 * type it. It is not a fallback bolted on; it is the path that always works, and
 * the buttons are the shortcut for the case where it can be skipped.
 *
 * There is no way to tell those two apart from in here — a browser cannot say
 * whose computer it is running on — so both are offered and the parent picks.
 * Guessing would produce a page that is confidently wrong half the time.
 */

const PLATFORMS = {
  windows: { key: 'windows', noun: 'Windows computer', button: 'Download for Windows' },
  mac: { key: 'mac', noun: 'Mac', button: 'Download for Mac' },
};

export default function ComputerSetup({ type, code }) {
  const platform = PLATFORMS[type];
  /**
   * What the API says is actually published.
   *
   * Asked rather than assumed, because the two answers lead to different
   * screens: an installer that exists gets a download button, and one that does
   * not gets a sentence saying so. The alternative — always rendering the button
   * — sends a parent to a 404 they will read as Parentix being broken, and there
   * is no way for them to find out otherwise.
   *
   * `null` while it is in flight, so the button is not drawn and then withdrawn.
   */
  const [release, setRelease] = useState(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    // Public endpoint, so a plain fetch rather than the authenticated client —
    // this is the same request the marketing site's download page makes.
    fetch(`${API_BASE_URL}/downloads/child-desktop`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('unavailable'))))
      .then((data) => { if (live) setRelease(data); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!platform) return null;

  const entry = release?.platforms?.[platform.key];
  const downloadUrl = `${API_BASE_URL}/downloads/child-desktop/${platform.key}`;
  const available = !!entry?.available;

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // Clipboard access is refused in plenty of ordinary situations — an
      // insecure origin, a permissions policy, an older browser. The code is on
      // screen and selectable either way, so this is a convenience that is
      // allowed to fail quietly rather than an error worth a message.
    }
  };

  return (
    <div className="space-y-5">
      {/* ── 1. Download ──────────────────────────────────────────────────── */}
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Step 1</p>
        <p className="text-sm text-gray-600 mt-1">
          On the {platform.noun} itself, download Parentix and run the installer.
        </p>

        {available ? (
          <>
            <a
              href={downloadUrl}
              className="btn-primary btn-block mt-3"
              // Not `target="_blank"`: this is a file, and a tab that opens and
              // immediately closes itself is the browser behaviour parents
              // report as "nothing happened".
            >
              <Icon name="download" size={16} />
              {platform.button}
            </a>
            <p className="text-xs text-gray-400 mt-2">
              Version {entry.version} · Windows will ask for an administrator password during
              installation, which is what lets Parentix filter websites.
            </p>
          </>
        ) : (
          <p className="text-sm text-gray-500 bg-gray-50 rounded-lg p-3 mt-3">
            {/* The API's sentence, not one composed here: it knows whether
                nothing was ever built for this platform or this deployment has
                nowhere to serve it from, and those are different answers. The
                fallback covers only the case where the call itself failed. */}
            {failed
              ? 'The download could not be checked just now. Try again in a moment.'
              : entry?.reason || 'That installer is not available yet.'}
          </p>
        )}
      </div>

      {/* ── 2. Connect ───────────────────────────────────────────────────── */}
      <div className="border-t border-gray-100 pt-5">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Step 2</p>
        <p className="text-sm text-gray-600 mt-1">
          When Parentix opens on that computer, connect it to {"this child's"} profile.
        </p>

        <p className="text-3xl sm:text-4xl font-mono font-bold text-primary-600 tracking-[0.2em] my-4 text-center">
          {code}
        </p>

        {/* Stacked, not side by side, and unconditionally.
            The sheet is about 440px wide whatever the window is, so two buttons
            in a row put "Connect this computer" on two lines against a one-line
            "Copy code" — which reads as a layout accident rather than a pair of
            equal choices. A `sm:flex-row` does not help: Tailwind's breakpoints
            are viewport queries, and the viewport is the desktop behind the
            modal, not the modal. */}
        <div className="flex flex-col gap-2">
          <button type="button" onClick={copyCode} className="btn-secondary flex-1">
            <Icon name={copied ? 'check' : 'copy'} size={16} />
            {copied ? 'Copied' : 'Copy code'}
          </button>
          {/*
            The shortcut, and it is only a shortcut. `parentix://` reaches the
            agent on *this* machine — so it finishes the job when the parent is
            sitting at the child's computer, and does nothing at all when they
            are not. A browser with no handler registered shows its own "no app
            found" dialog, which is why the sentence below says what the button
            is for rather than leaving the parent to find out from an error.
          */}
          <a href={`parentix://link/${encodeURIComponent(code)}`} className="btn-primary flex-1">
            <Icon name="link" size={16} />
            Connect this computer
          </a>
        </div>

        <p className="text-xs text-gray-400 mt-3">
          Use <span className="font-medium text-gray-600">Connect this computer</span> only if you
          are reading this on the {platform.noun} you are setting up. Otherwise type the code into
          Parentix on that computer — it is valid for 30 minutes.
        </p>
      </div>
    </div>
  );
}
