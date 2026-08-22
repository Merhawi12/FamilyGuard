import { UNSUPPORTED } from './contract.js';

/**
 * The one place the agent reaches the machine it is running on.
 *
 * A host installs its implementation once, before starting the agent; every
 * service reads it through `platform()`. Injection rather than a
 * `process.platform` switch inside each service is what lets the whole agent run
 * under plain Node in `scripts/e2e.mjs` — the harness installs a fake and drives
 * the shipping services against a real API, which is how the mobile app's
 * contract is covered too.
 */
let _platform = UNSUPPORTED;

/** Fills in anything a host left out, so a partial implementation cannot crash. */
export function setPlatform(impl) {
  _platform = {
    ...UNSUPPORTED,
    ...impl,
    secureStorage: { ...UNSUPPORTED.secureStorage, ...impl?.secureStorage },
    foreground: { ...UNSUPPORTED.foreground, ...impl?.foreground },
    apps: { ...UNSUPPORTED.apps, ...impl?.apps },
    dns: { ...UNSUPPORTED.dns, ...impl?.dns },
    lockScreen: { ...UNSUPPORTED.lockScreen, ...impl?.lockScreen },
    autostart: { ...UNSUPPORTED.autostart, ...impl?.autostart },
    permissions: { ...UNSUPPORTED.permissions, ...impl?.permissions },
  };
  return _platform;
}

export function platform() {
  return _platform;
}

export { UNSUPPORTED };
