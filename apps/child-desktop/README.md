# Child Desktop — two platform projects

The monitored **laptop** agent, as **two Electron projects that share one body of
JavaScript**. Same shape as [`apps/child-app`](../child-app/README.md), same
reason.

```
apps/child-desktop/
├── shared/        @parentix/child-desktop-shared — the agent, the child-facing
│                  windows, the DNS resolver, and the platform contract
├── windows/       Electron project root · PowerShell platform modules · NSIS
└── macos/         Electron project root · shell + launchd platform modules · pkg
```

A platform project is a `package.json`, an electron-builder block, a `build/`
directory of packaging resources, and **one object implementing four
capabilities**. No product behaviour lives in either of them. The difference
between the two applications is one import in `main.js`.

---

## 1. What a desktop can do, and what it cannot

The agent answers to the same rules as the phones, and it is worth being precise
about where the two differ — a family with a phone and a laptop should not need
two mental models, and the places they genuinely diverge are places where
pretending otherwise would mislead a parent.

| | Child App (Android) | Child Desktop |
| --- | --- | --- |
| Screen time | read from `UsageStatsManager` | **measured** by sampling the front window |
| Blocking an app | drawn over, left running | the app is closed, and the child is told |
| A full lock | drawn over | a lock screen over every display |
| Websites | local `VpnService`, DNS refused | local resolver, DNS refused |
| Web history | from the same DNS proxy | from the same local resolver |
| Contacts | synced, shown to the child | identical |
| Chat + SOS | socket, REST fallback | identical |
| Location | GPS, background | **not reported at all** |
| Push | Expo → FCM | **none** — the agent is always running |

**There is no location on a desktop, and inventing one would be worse than
having none.** A laptop has no GPS. The substitutes — Wi-Fi geolocation, the IP
address — would put a marker on the parent's map that looks exactly like a fix
from their child's phone while being, in the IP case, the middle of whichever
city their ISP peers in. A parent reading that map cannot tell the two apart.

**There is no push, and none is needed.** Push exists on the phones because the
socket is only alive while the app is. This agent runs from sign-in to shutdown,
so the socket *is* the delivery channel, and notifications go through the OS
directly.

## 2. Screen time is measured, not read

Neither Windows nor macOS has an equivalent of `UsageStatsManager`, so the agent
asks which window is in front every five seconds and credits the elapsed time to
whatever was there. Everything difficult about that is a way of **not** counting
time the child was not present:

- **The platform stops sampling when nobody is there.** Idle, locked, asleep and
  screensaver are all the platform's judgement, because only it knows how to ask
  — `GetLastInputInfo` on Windows, `HIDIdleTime` from `ioreg` on macOS.
- **A gap longer than 90 seconds is credited to nobody.** Even an attentive host
  has gaps: a restart, a hibernate with no warning, a late tick. A long gap is
  evidence the child was absent.
- **Totals survive a restart.** The daily limit is enforced against this number.
  If it reset when the agent restarted, closing and reopening Parentix would be
  all it took to get the afternoon back — which is precisely what a child who has
  just been locked out will try.

The identifier a rule is written against is `chrome.exe` on Windows and
`com.google.Chrome` on macOS. Both reach the parent's app picker the same way
the phone's package names do — from the usage samples this machine uploads — so
`GET /blocking/:childId/apps/known` fills the rule form in with no API change.

## 3. Websites: one local resolver, two features

Website blocking and web history are the same mechanism, because on a desktop
they genuinely are: the machine's resolver is pointed at `127.0.0.1`, every
lookup arrives at `shared/src/dns/proxy.js`, a blocked name is answered NXDOMAIN
and everything else is relayed to whichever resolver the machine was already
using. Nothing is sent anywhere that was not already going there, and no traffic
is inspected — what the agent learns is the set of names that were looked up,
which is exactly what `POST /devices/me/web-history` accepts.

Three things are worth knowing before touching it:

- **DNS-over-HTTPS goes around it.** A browser resolving names over its own HTTPS
  connection never asks this proxy anything. That is handled rather than ignored:
  the Firefox canary `use-application-dns.net` is answered NXDOMAIN, which is the
  documented way for a managed network to say "do not bypass me", and the DoH
  bootstrap hostnames are refused so a browser falls back to the system resolver.
  It is a negotiation with browser vendors, not a guarantee.
- **IPv6 is not optional cover, it is the hole.** A router advertising an IPv6
  resolver leaves the machine with a working name service that never reaches this
  one — a filter that appears to be running and quietly sees nothing. Both
  families are answered and both are redirected.
- **Changing the resolver needs elevation, and the failure is dangerous.** A
  machine pointed at `127.0.0.1` with nothing listening has no internet at all
  and nothing on screen would explain why. See §5.

## 4. The lock screen is a deterrent, not a cage

When a screen-time rule bites, a full-screen window opens on every display,
above everything, and takes the focus back whenever it loses it. It **closes
nothing** — bedtime arriving mid-essay must not be the thing that loses the
essay — and it offers "Ask for more time", which sends a real message to the
parent.

A child who knows how can still reach a terminal on either platform and end the
process. What this does is make the boundary unmissable and un-crossable by
accident. Turning it into something stronger means a Windows service or a macOS
daemon that a user session cannot terminate; that is a different product
decision, with an uninstall story attached, and not one to make quietly.

## 5. Elevation, and the two ways it is obtained

Everything except website filtering works in an ordinary user session. Filtering
does not, on either platform, and the degradation is stated in the app rather
than hidden: the Settings window shows *"Website filtering needs Parentix to run
as an administrator"* and the monitor reads Off.

**Windows.** The application manifest is `asInvoker`, deliberately: marking it
`requireAdministrator` would put a UAC prompt in front of a child at every
sign-in, and Windows will not auto-start an elevated application from the Run key
at all. The installer — which is already elevated — instead registers a
**scheduled task** that runs the agent at logon with the highest privileges the
account has. See [`windows/build/installer.nsh`](windows/build/installer.nsh).

> **Install as the child.** The task is created for the account running the
> installer. Sign in as the child, run the installer, and enter the
> administrator password at the UAC prompt.

**macOS.** The GUI agent is not root and should not be. A fourteen-line shell
script runs as root under launchd, and the agent asks it by writing a request
file that launchd is watching (`WatchPaths`). **The protocol carries no
addresses** — `/Users/Shared` is writable by every local account, so a request
naming a DNS server would be a local privilege escalation shipped inside a
parental control. The helper decides what "redirect" means and keeps its own
root-owned snapshot.

## 6. Putting the machine back

The most dangerous thing here is not the filtering, it is the system setting.
Four things guard it, and they are why `webFilter.js` is bigger than the proxy it
wraps:

1. The proxy is listening **before** the machine is pointed at it, and the machine
   is pointed back **before** the proxy closes.
2. The previous resolvers are written to disk **before** the change, so a restore
   is possible from a cold start by a process with no memory of what it replaced.
3. **Startup repairs before it applies** — a marker on disk means the last run did
   not end cleanly. On macOS the launchd helper does the same at boot, before
   anyone has signed in.
4. The uninstaller restores too, because an uninstall is the one path with no
   next startup.

## 7. Working on it

```bash
# Install — each project separately; there is no hoisted root install.
npm --prefix apps/child-desktop/windows install
npm --prefix apps/child-desktop/macos install

# Run it against a local API
PARENTIX_API_URL=http://127.0.0.1:5000/api npm run dev:desktop        # Windows
PARENTIX_API_URL=http://127.0.0.1:5000/api npm run dev:desktop:mac    # macOS

# Installers
npm run desktop:win        # NSIS, x64 + arm64
npm run desktop:mac        # .pkg + .dmg — needs macOS

# Tests
npm run lint
npm run test:e2e:desktop   # 59 checks against a real API and a real resolver
npm run assets             # regenerate build/icon.png and build/tray.png
```

`npm run dev` adds a **Quit** item to the tray, which the shipping build does not
have: an agent a child can stop from a menu is not a parental control. Use it
rather than Task Manager — ending the process outside the shutdown handler is how
you leave your own machine's resolver pointed at a proxy that is no longer there.

Full detail: [docs/CHILD-DESKTOP.md](../../docs/CHILD-DESKTOP.md).
