/**
 * The only thing the child-facing windows can reach.
 *
 * CommonJS, and that is not an oversight: Electron loads preload scripts in a
 * sandboxed context that has no ESM loader, so a `.js` file in a
 * `"type": "module"` package would fail to load and the window would come up
 * with no bridge and no error worth reading. `.cjs` states the format regardless
 * of what the package says.
 *
 * `contextIsolation` is on and `nodeIntegration` is off, so the renderer has no
 * `require`, no `process` and no filesystem — it has exactly the calls below.
 * That matters more here than in an ordinary app: this window is on a child's
 * computer, it is the surface of the thing restricting them, and a renderer with
 * Node in it would be a way to switch the agent off from a page it already has
 * open.
 *
 * Every call returns `{ ok, value }` or `{ ok: false, error }` over IPC and is
 * unwrapped here, because Electron rewraps a thrown error as "Error invoking
 * remote method …" — and the message the child needs to read is the server's
 * ("That code has expired"), not Electron's.
 */
const { contextBridge, ipcRenderer } = require('electron');

const argument = (name, fallback = '') => {
  const prefix = `--parentix-${name}=`;
  const match = process.argv.find((value) => value.startsWith(prefix));
  return match ? decodeURIComponent(match.slice(prefix.length)) : fallback;
};

async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (result && result.ok === false) throw new Error(result.error || 'Something went wrong.');
  return result ? result.value : undefined;
}

contextBridge.exposeInMainWorld('parentix', {
  /** Which backend this build talks to — shown on the link screen. */
  apiHost: argument('api-host', 'api.parentix.ca'),

  getStatus: () => call('agent:status'),
  onStatus: (handler) => {
    ipcRenderer.on('agent:status', (_event, status) => handler(status));
  },

  link: (code) => call('agent:link', code),

  messages: {
    list: () => call('chat:list'),
    send: (text) => call('chat:send', text),
    sendEmergency: () => call('chat:emergency'),
    onMessage: (handler) => {
      ipcRenderer.on('chat:message', (_event, message) => handler(message));
    },
  },

  permissions: {
    list: () => call('permissions:list'),
    open: (key) => call('permissions:open', key),
  },

  autostart: {
    get: () => call('autostart:get'),
    set: (on) => call('autostart:set', !!on),
  },

  // ── Lock window only ────────────────────────────────────────────────────────
  lockState: (() => {
    try { return JSON.parse(argument('lock-state', 'null')); } catch { return null; }
  })(),
  onLockState: (handler) => {
    ipcRenderer.on('lock:state', (_event, state) => handler(state));
  },
});
