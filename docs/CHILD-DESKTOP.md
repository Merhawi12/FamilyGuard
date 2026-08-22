# Child Desktop

The Parentix agent for a child's Windows or Mac laptop. This is the reference
for how it is put together, what each platform can and cannot do, how it is
built and signed, and what has actually been verified.

For the short version, read [`apps/child-desktop/README.md`](../apps/child-desktop/README.md).

---

## 1. Where things live

```
apps/child-desktop/
├── shared/                     @parentix/child-desktop-shared  (ESM, no deps of its own)
│   ├── preload.cjs             the only surface the renderer can reach
│   ├── src/
│   │   ├── platform/           the contract, and an all-off default
│   │   ├── host/               Electron: windows, tray, IPC, lifecycle
│   │   ├── services/           the agent and everything it owns
│   │   ├── dns/                the local resolver
│   │   └── ui/                 the child-facing windows (plain modules, no build step)
│   └── scripts/e2e.mjs         59 checks against a real API and a real resolver
├── windows/
│   ├── main.js                 one import
│   ├── src/platform/           powershell.js · foreground.js · processes.js · dns.js · permissions.js
│   └── build/                  icon.png · tray.png · installer.nsh
└── macos/
    ├── main.js                 one import
    ├── src/platform/           shell.js · foreground.js · processes.js · dns.js · permissions.js
    └── build/                  icon.png · tray.png · entitlements · launchd/ · pkg-scripts/
```

`shared/` declares `axios`, `socket.io-client` and `electron` as
**peerDependencies** and has no dependencies of its own, so the copy in a build
is always the platform project's. Same rule, and the same reason, as the child
app's shared package.

### Why two projects rather than one with a `process.platform` switch

The same argument the child app makes. The signing material, the installer
format, the packaging resources and the platform modules are genuinely
per-platform, and a single project would carry both sets of everything and
choose at runtime — which means a Windows build shipping macOS launchd plists,
and an electron-builder config with two of every key. Splitting them puts the
choice at the top of `main.js` and leaves everything below it identical.

They are **not npm workspaces**, for the same reason the child app's are not:
each installs alone, links `shared/` with `file:`, and keeps its own lockfile.

## 2. The platform contract

`shared/src/platform/contract.js` is the whole of what differs between a Windows
laptop and a Mac. Two rules govern it:

**A capability that is missing says so.** Every group carries `supported`.
Nothing returns a plausible-looking zero — a screen-time figure of 0m is
indistinguishable from a well-behaved child, and a parent reading one has been
told something false. The Settings window filters on `supported`, so a capability
the machine cannot provide is *absent* rather than permanently switched off.

**A capability that needs a permission reports which one.** `permissions.list()`
names it, so the child can be walked through granting it.

| Group | What it does | Windows | macOS |
| --- | --- | --- | --- |
| `foreground` | which app is in front, over time | `powershell.exe` + P/Invoke | `lsappinfo` + `ioreg` |
| `apps` | close a running application | `CloseMainWindow` then `Kill` | `SIGTERM` then `SIGKILL` |
| `dns` | point the machine at the local resolver | `Set-DnsClientServerAddress` | `networksetup`, via a launchd helper |
| `permissions` | what is missing, and why | administrator | the DNS helper |

Everything else — the encrypted store, notifications, windows, the tray,
autostart — is Electron's and lives in `shared/src/host/`.

### No native modules, on purpose

Every platform capability is a command-line tool. The alternative is node-gyp, a
toolchain on every build machine, `electron-rebuild` against each Electron
version, and a binary per architecture — for four things both operating systems
already expose to a script. `powershell.exe` 5.1 ships with every supported
Windows; `lsappinfo`, `ioreg` and `networksetup` ship with every macOS.

On Windows, scripts are passed as **`-EncodedCommand`, never as a file**:
electron-builder packs the app into `app.asar`, which is an archive, and a `.ps1`
inside it has a path that looks real and that PowerShell cannot open.

## 3. Screen time

Sampled every five seconds. See `shared/src/services/screenTime.js`.

- **The host only ticks while somebody is using the computer.** Idle, locked,
  asleep and screensaver all mean "stop sampling", and that judgement is the
  platform's because only it knows how to ask.
- **A gap over `MAX_CREDIT_MS` (90s) is credited to nobody.**
- **Totals are persisted every tick**, because the daily limit is enforced
  against them and a restart must not hand the afternoon back.
- **This agent excludes itself**, by executable name and by bundle identifier —
  the mobile app's exclusion list named the wrong identifier once, and every
  minute a child spent on the screen telling them how much time they had left was
  charged against that time.

### Two Windows details a naive implementation gets wrong

**Store apps are hosted.** Every packaged app — Calculator, Settings, Photos, a
great many games — has a foreground window owned by `ApplicationFrameHost.exe`.
Reporting the frame host makes the child's most-used application a Windows
internal and makes a rule against a Store app unmatchable. The real owner is the
first child window belonging to a different process.

**The name a parent recognises is the file description**, not the process name:
`chrome.exe` → "Google Chrome". Read from the executable, cached per process
name, and falling back to the process name for a protected process.

### One macOS detail that decides the whole design

The obvious way to ask which app is frontmost is
`tell application "System Events" …`, and it raises a TCC consent dialog:
*"Parentix wants to control System Events."* A child who clicks Don't Allow has
switched screen time off, macOS will not ask again, and the parent is told
nothing. `lsappinfo` answers the same question with no consent and cannot be
refused. Closing an app with a signal rather than an AppleScript `quit` avoids
the same prompt.

**The result is that this agent asks macOS for no TCC permission at all**, which
is worth more than any single feature it could have bought with one.

## 4. App blocking

`shared/src/services/appControl.js` decides; the platform acts.

The decision is a port of the mobile app's, because it has to be: an outright
block rule, a per-app daily limit that has been spent, and a full lock (the `*`
wildcard). A parent who blocks an app expects the same answer on the laptop as on
the phone.

The enforcement cannot be a port. Android draws over the app; a desktop closes
it. Two things soften that:

- **The child is told, every time.** An application that vanishes with no
  explanation reads as a crash, and a child who thinks the laptop is broken tells
  nobody.
- **A full lock closes nothing.** The lock screen takes the display and leaves
  the work underneath it.

### The deny-list is the most important thing in those files

A rule is a string a parent typed. The form offers what the machine has reported,
but the field is free text, and a parent who blocks `explorer.exe` because they
saw it in a list has asked the agent to take the desktop away. Worse are the ones
that bugcheck the machine: terminating `csrss.exe`, `wininit.exe`, `services.exe`
or `lsass.exe` is a blue screen, not an error message. Parentix itself is on both
lists — an agent that can be told to close itself is one a child can switch off
with a single rule they talk their parent into.

## 5. Websites and web history

One local DNS resolver, `shared/src/dns/`. `wire.js` is just enough of RFC 1035
to read a question and refuse it; the proxy never builds an answer, because every
allowed lookup is relayed verbatim and the reply comes back untouched.

- Blocked → **NXDOMAIN**. An address that goes nowhere leaves the browser opening
  a connection that hangs; NXDOMAIN fails immediately, which is both faster and
  closer to the truth.
- A rule for `example.com` covers the site: exact match or a dot-boundary suffix.
- Recorded: `A`, `AAAA` and `HTTPS` queries, excluding `.arpa`. One entry per
  domain per flush window, in the exact shape `POST /devices/me/web-history`
  accepts.
- **Never forward to ourselves.** Reading the machine's resolvers *after*
  redirecting them returns `127.0.0.1`, and a proxy that asks itself answers
  nothing — which presents as a laptop with no internet rather than as an error.

### DNS-over-HTTPS

A browser resolving over its own HTTPS connection never asks this proxy anything.
Two mitigations, neither a guarantee:

- `use-application-dns.net` is answered NXDOMAIN. That is the documented
  mechanism for a managed network to tell Firefox not to enable DoH, and Firefox
  honours it. Without it a Firefox install silently stops being filtered *and*
  stops appearing in web history, with nothing anywhere to indicate it.
- The DoH bootstrap hostnames (`mozilla.cloudflare-dns.com`, `dns.google`, …) are
  refused, so a browser that cannot resolve its provider falls back to the system
  resolver.

### IPv6

A router advertising an IPv6 resolver leaves the machine with a working name
service that never reaches this one — a filter that appears to be running and
sees nothing. The proxy binds `::1` as well as `127.0.0.1`, and only redirects the
IPv6 resolver when that bind actually succeeded. Redirecting IPv6 to an address
with nothing behind it is how a filter takes a machine off the network instead of
filtering it.

## 6. Elevation

|  | Windows | macOS |
| --- | --- | --- |
| Needs root/admin | `Set-DnsClientServerAddress` | `networksetup -setdnsservers` |
| How it is obtained | a scheduled task at logon, `/RL HIGHEST` | a launchd daemon running a root helper |
| Created by | the NSIS installer (already elevated) | the `.pkg` postinstall (runs as root) |
| Without it | filtering and web history off, and the app says so | the same |

### Windows

`requestedExecutionLevel: asInvoker`. Marking the app `requireAdministrator`
would put a UAC prompt in front of the child at every sign-in, **and Windows will
not auto-start an elevated app from the Run key at all** — the agent would simply
never start on its own. `build/installer.nsh` registers
`schtasks /Create /RL HIGHEST /SC ONLOGON` instead.

> **Install while signed in as the child.** The task is created for the account
> running the installer, because that is the logon it has to trigger on.

Electron's own login item is still set by the app, so a machine where the task
could not be created still gets a running agent — unelevated, with filtering off,
and saying so.

### macOS

The GUI agent is not root and should not be; an Electron app running as root on a
Mac is a larger problem than the one it would solve. So:

```
/Library/LaunchDaemons/ca.parentix.child-desktop.helper.plist   root:wheel 644
/Library/Application Support/Parentix/dns-helper.sh             root:wheel 755
/Users/Shared/Parentix/                                         1777
```

The agent writes `/Users/Shared/Parentix/dns-request.json`; launchd starts the
helper on the change (`WatchPaths`); the helper writes `dns-result.json` with the
same id. No socket, no resident daemon.

**The protocol carries no addresses, and that is the security design.**
`/Users/Shared` is writable by every local account, so anything the helper
accepts, any local user can ask for as root. A request naming DNS servers would
be a local privilege escalation shipped inside a parental control. The helper
takes exactly `redirect` and `restore`, decides that "redirect" means the
loopback, and keeps its own root-owned snapshot of what was there before. The
worst a local user can do is toggle Parentix's own filter, which is no more than
quitting the app already gives them.

launchd's plist permissions are load-bearing rather than tidy: it silently
refuses a daemon plist that a non-root account can write.

## 7. Putting the machine back

The most dangerous thing in this feature is not the filtering, it is the system
setting. A machine whose resolver points at `127.0.0.1` with nothing listening
has no internet at all, and nothing on screen would explain why.

1. **Order.** The proxy is listening before the machine is pointed at it; the
   machine is pointed back before the proxy closes. There is no window in which
   the resolver is loopback with nothing behind it.
2. **A marker on disk, written before the change.** `repairSystemDns()` reads it
   at every start: its presence means the last run did not end cleanly.
3. **Boot repair on macOS.** `RunAtLoad` on the helper, with a request file older
   than two minutes treated as a boot run rather than an instruction — a snapshot
   existing at boot can only mean the Mac was shut down while redirected.
4. **The uninstaller restores**, because an uninstall is the one path with no next
   startup. The Windows uninstaller resets to DHCP rather than parsing the backup:
   a household that had set its own resolver will find it back on the ISP's, which
   is a real cost and a deliberate one — the alternative is JSON parsing inside an
   NSIS-escaped PowerShell one-liner on the path whose whole job is to be the one
   that works.

A shutdown gets `SHUTDOWN_GRACE_MS` (8s) to finish, then the app exits anyway.
Windows and macOS both kill an app that will not close, and a shutdown that blocks
on a network call is a machine that will not turn off.

## 8. Security of the windows

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, a CSP in
every document, and a `.cjs` preload exposing about a dozen calls. This matters
more here than in an ordinary app: the window is on a child's computer, it is the
surface of the thing restricting them, and a renderer with Node in it would be a
way to switch the agent off from a page it already has open.

Every string that reaches the DOM goes through `textContent`. App names and
window titles come off the machine and message text comes from a parent — none of
it is ours.

The device credential is sealed with Electron's `safeStorage`: DPAPI on Windows,
the login Keychain on macOS. When encryption is unavailable, linking is refused
rather than storing a token in the clear — a file that authenticates as the child
should not be readable by copying it off the disk.

## 9. Building and signing

```bash
npm run desktop:win     # NSIS x64 + arm64  → apps/child-desktop/windows/dist
npm run desktop:mac     # .pkg + .dmg       → apps/child-desktop/macos/dist   (needs macOS)
```

Icons come from `scripts/build-brand-assets.mjs` (`npm run assets`), which writes
`build/icon.png` and `build/tray.png` into both projects from the one source
mark. `icon.png` is a **source**: electron-builder converts it to `.ico` and
`.icns` at package time, which is why neither format is committed. `tray.png` is
drawn on the brand teal rather than transparent — a white silhouette on nothing
is right for Android's status bar, where the system tints it, and wrong for a
desktop tray that has to be legible against a black taskbar and a white one
without either platform touching it.

> **The `.pkg` scripts must be executable in git.** `productbuild` refuses a
> `preinstall`/`postinstall` without the execute bit, and Windows checkouts do
> not carry one — so on a first commit from a Windows machine they need
> `git update-index --chmod=+x apps/child-desktop/macos/build/pkg-scripts/*`.
> `dns-helper.sh` does not need it: `postinstall` copies it and `chmod 755`s it
> as part of the install.

**Signing is not configured and both installers are unsigned.** On Windows that
is a SmartScreen warning on first run; on macOS it is Gatekeeper refusing the
`.pkg` outright. Shipping needs:

- Windows: an EV or OV code-signing certificate, and `win.certificateFile` /
  `certificatePassword` (or an Azure Trusted Signing config).
- macOS: a Developer ID Application **and** a Developer ID Installer certificate,
  `hardenedRuntime` (already on), and notarisation — `notarize` in the `mac`
  block plus `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`.

The entitlements are deliberately short. The app is **not sandboxed** — that is
what lets it spawn `lsappinfo` and signal another process, and no entitlement
gives those back inside the sandbox, which is why this ships outside the Mac App
Store. There is **no Network Extension entitlement**: `NEDNSProxyProvider` is
Apple's blessed route to website filtering and is granted by application, on a
review cycle, with the extension needing user approval. The launchd helper reaches
the same place with no Apple negotiation. If the entitlement is ever granted,
`src/dns/proxy.js` moves into the provider and nothing else changes.

## 10. What has been verified, and what has not

**Verified by running it, on Windows, 2026-08-17:**

- `npm run test:e2e:desktop` — **59 checks** against a real API, driving the
  shipping service layer. The DNS proxy is the real one, on a high port, with a
  real upstream on the loopback: blocked, allowed, canary and DoH lookups are
  actual packets and the response codes are read off the wire. A parent socket
  connects alongside, so "the parent sees it" is checked on a second client.
- The real Electron application, driven with Playwright: it boots to the link
  screen, redeems a real code, switches to My Day with the child's name and the
  parent's limit, lists the blocked app and site, reports the unelevated state
  honestly (*"Website filtering needs Parentix to run as an administrator"*), and
  sends a message that arrives on the parent's socket. The parent's device list
  shows `type: windows` and `Windows 11 Pro 10.0.26200`.
- The lock screen: a bedtime window covering the current time raised it on the
  display within seconds, showed *"It is bedtime, Sam"*, its "Ask for more time"
  button put a real message in the parent's thread, and lifting the rule took it
  away.
- `services/api/tests/childDesktopPlatforms.test.js` — 23 tests pinning the
  agreements that drift silently.

**Not verified, and each needs a machine:**

- **Every line of the macOS platform modules.** `lsappinfo`, `ioreg`,
  `networksetup`, the launchd plist, the helper script and the pkg scripts have
  never been run — the dev machine is Windows. This is the same position
  `docs/IOS.md` was in before an EAS build, and it should be treated the same
  way: read as a design, not as a tested one.
- **The elevated Windows path.** The PowerShell foreground watcher and the app
  closer were exercised through the harness's fake platform, not against
  `powershell.exe`. `Set-DnsClientServerAddress` has never been called by this
  code on a real machine, so the redirect, the restore and the DHCP-vs-static
  distinction are unproven.
- **Both installers.** Nothing has been packaged. The NSIS scheduled task, the
  `.pkg` scripts and the icon conversion are all untried.

The first two are the ones to do first, and in that order.

## 11. Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PARENTIX_API_URL` | `https://api.parentix.ca/api` | which backend this build talks to |
| `PARENTIX_SOCKET_URL` | derived from the API URL | realtime host |
| `PARENTIX_DNS_PORT` | `53` | the resolver's port. Anything else skips the system change — `netsh` and `networksetup` set an address, not a port, so a proxy on 5353 would never be consulted |
| `PARENTIX_DNS_UPSTREAM_PORT` | `53` | where allowed lookups go; for the harness only |
| `PARENTIX_DEV` / `--dev` | unset | adds a Quit item to the tray |

The API host is **shown on the link screen**, and that is not decoration. A
linking code is a row in one database, so a parent whose dashboard is pointed at
a different deployment hands over a perfectly well-formed code that this
computer's server has genuinely never seen — an eternal "not recognised" with no
defect anywhere in the code. Printing both hostnames is the only way anyone finds
it.
