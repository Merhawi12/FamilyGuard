# Security

What protects this platform, where each control lives, and what is deliberately
not protected. Written to be checked against the source rather than believed —
every claim below names the file that makes it true.

Parentix holds a child's location history, browsing, contacts and messages. The
threat that matters is not a defaced marketing page; it is one family's records
reaching someone outside that family. Almost everything here follows from that.

## Identity

| Who        | Credential                    | Minted by                              |
| ---------- | ----------------------------- | -------------------------------------- |
| Parent     | JWT `{ id, sid }`, 7 days     | `utils/session.js` → `createSession`   |
| Staff      | the same, with a staff `role` | as above                               |
| Child device | JWT `{ deviceId, childId }`, 365 days | `controllers/deviceController.js` → `confirmLink` |
| Pre-auth (MFA) | JWT `{ id, mfaRequired }`, 5 min | `controllers/authController.js` → `signPreAuthToken` |
| Cloud Scheduler | Google OIDC identity token | Google; verified in `routes/tasks.js`  |

Every one is HS256 and verified with an explicit algorithm allow-list
(`utils/jwtOptions.js`) so a future move to a key object cannot silently reopen
algorithm confusion.

**A parent token is only live while its session row is.** `middleware/auth.js`
looks `sid` up on every request, so sign-out, an admin force-logout, a password
change and a role change all take effect immediately rather than at expiry. The
Socket.IO handshake performs the same lookup (`sockets/auth.js`), and revocation
also disconnects sockets that are already open (`utils/session.js`).

**A device token is only as authorised as the family above it.**
`authenticateDevice` walks device → child → parent and refuses if any link is
inactive, with `device_unlinked` (permanent, forget the credential) distinguished
from `account_suspended` (temporary, keep retrying) — see `utils/deviceAccess.js`.
Identity comes from the **device row**, never from the token's `childId` claim;
a token whose claim disagrees with the row is refused
(`tests/tokenBinding.test.js`).

**The MFA pre-auth token authenticates nothing but `/mfa/validate`.** It carries
no `sid`, which once meant the session lookup was skipped entirely and a password
alone reached every route for five minutes. `middleware/auth.js` now refuses
`mfaRequired` before it looks at any other claim.

## Guessable secrets

Five things on this service can be guessed. All five are bounded the same way:
per-credential attempts, and an account-wide lockout that does not care which IP
the guesses come from.

| Secret                | Per-credential budget                | Account lockout |
| --------------------- | ------------------------------------ | --------------- |
| Password              | —                                    | 5 → 15 min      |
| Email verification code | 5 wrong guesses burn the code      | 5 → 15 min      |
| SMS sign-in code      | 5 wrong guesses burn the code        | 5 → 15 min      |
| TOTP / backup code    | —                                    | 5 → 15 min      |
| Password-reset code   | 5 wrong guesses burn the code        | **none, deliberately** |

The reset code is the exception on purpose: counting it would let anyone who
knows an address lock its owner out of the one flow that exists to get them back
in. Bounding it by burning the code costs the attacker a code rather than costing
the owner their recovery path. See `utils/otp.js` and `utils/loginAttempts.js`.

Resends are limited **against the recipient**, not the caller — one code a
minute, five an hour per account — because a per-IP limit does nothing about
somebody being mail-bombed from many machines.

Sign-in answers "no such address" and "wrong password" identically, and takes the
same time doing it: the branches with no hash to check burn an equivalent bcrypt
comparison (`utils/password.js` → `burnPasswordComparison`), because a
short-circuit enumerates the customer base as reliably as an error message would.

## Secrets at rest

Nothing that authenticates anybody is readable from a database dump.

| Column                        | Storage                                    |
| ----------------------------- | ------------------------------------------ |
| `users.password_hash`         | bcrypt, cost 12                             |
| `users.*_verification_code`   | HMAC-SHA256 keyed from `JWT_SECRET`         |
| `users.password_reset_code`   | as above                                    |
| `users.password_reset_token`  | as above, separate label (`otp.hashTicket`) |
| `users.mfa_secret`            | AES-256-GCM (`utils/crypto.js`)             |
| `users.mfa_backup_codes`      | bcrypt                                      |
| `push_tokens.token`           | AES-256-GCM, with a blind index for lookup  |
| `activity_logs.url`           | AES-256-GCM, with a blind index for lookup  |
| `contact_messages.ip_hash`    | SHA-256, salted with the field key          |

Two rules make this hold rather than drift:

- **Hashing and encryption live in the model, not the controller.** There are
  four write paths for a verification code and the one that forgets is the one
  that leaves live digits in a backup, so the setters do it (`models/User.js`).
- **A comparison never accepts stored form as input.** `otp.codeMatches`
  deliberately hashes through `digest` rather than the idempotent `hashCode`, so
  pass-the-hash cannot give back what hashing takes away.

The reset *ticket* cannot use `hashCode` at all — it is 64 hex characters, which
that function's already-hashed passthrough would mistake for its own output and
store verbatim. `otp.hashTicket` always hashes. This is pinned by
`tests/secretsAtRest.test.js`, which reads the raw columns underneath the ORM,
because asserting through the ORM would prove nothing.

Keys come from Secret Manager and never from the database, so a dump on its own
yields nothing usable. `FIELD_ENCRYPTION_KEY` must be 64 hex characters or the
API refuses to boot.

## Authorisation

Every route is authenticated (`routes/*.js`); there are no unauthenticated
mutations except `POST /devices/confirm` (where the linking code *is* the
credential), the Stripe webhook (signature-verified), the contact form, and the
sign-in family itself.

**Family data is scoped by ownership, in the query.** A parent-facing handler
resolves the child through `Child.findOne({ where: { id, parentId } })` before
touching anything, so another family's id reads as 404 rather than 403 — which
would confirm the row exists. A malformed UUID is checked *before* the query
(`utils/ids.js`): Postgres rejects one outright, which would turn "not found"
into a 500 that SQLite-only tests never see.

**A device is never sent a sibling's rules.** The filtering is in SQL
(`utils/deviceScope.js`), so nothing on the phone has to be trusted to ignore
one.

**Staff permissions are per-account, not per-role.** `config/roles.js` seeds a
role's defaults; `permissions` on the row is the effective grant. Managing staff
is Super Admin only rather than a grantable permission, so no department account
can promote itself. A role or permission change revokes that user's sessions
immediately. The last active Super Admin cannot be demoted, deactivated or
deleted.

**Realtime rooms come from the handshake, never from the client.**
`sockets/deviceEvents.js` ignores every id in an event payload. The `role ===
'parent'` check on the parent room is load-bearing: a child socket also carries
`parentId`, and joining on that field alone put every child's phone in the room
receiving the whole household's alerts and locations.

## The network edge

- **CORS is an allow-list and nothing else** (`app.js`). A hostname the API has
  not been told about fails at the browser. The Socket.IO handshake *errors* on a
  refusal rather than answering `{ origin: false }` — omitting the headers still
  completes the upgrade, and a socket that has completed is connected whatever a
  browser makes of it.
- The one extra origin the handshake accepts is the API's own host, because React
  Native fills in `getDefaultOrigin(url)` whether or not anyone asked. It admits
  nobody who was not already admitted: a non-browser client can send no Origin at
  all, and a browser can never reach the branch.
- `helmet()` on every response; `X-Powered-By` off; `trust proxy` set to the one
  hop in front of Express so rate limits and audit logs key off the real caller.
- A 300/min backstop on `/api`, with tighter buckets on login, registration, code
  entry, device linking, uploads and the contact form. The SMS bucket is tightest
  because every call there spends money and lands on a real handset.
- 5xx responses never carry internals in production; every response carries
  `X-Request-Id`, which is what connects a user report to a log line.

### The per-IP limits are per *instance*

`express-rate-limit` counts in process memory, and production runs
`api_max_instances = 6` — so "10 login attempts per 15 minutes" is ten per
instance, and requests landing on different instances get up to sixty. Under an
attack that is the likely case, because the load itself is what scales the
service out.

This is bounded rather than open, and it is worth being precise about what it
does and does not touch. **Credential guessing is unaffected**: the account
lockout (`utils/loginAttempts.js`) and the per-code attempt budget
(`utils/otp.js`) both live in the database, so five wrong passwords lock the
account and five wrong codes burn the code wherever the attempts land. What the
per-IP ceilings uniquely bound is work with no account to lock — probing which
addresses exist, bulk registration, and `POST /auth/phone/request`, where every
call past the limiter spends money at Twilio. Even there the resend limits in
`utils/otp.js` cap the messages any one number can receive.

Memorystore is already deployed for the Socket.IO adapter, so a shared store is
the obvious fix and was written and then **deliberately reverted**. With
`rate-limit-redis`, each store loads its Lua scripts at construction and caches
the resulting promise; a Redis blip during boot rejects it permanently, and the
store never recovers for the life of that instance. Combined with
`passOnStoreError` — which is the right setting, because failing closed turns a
Memorystore hiccup into "nobody can sign in" — that trades a diluted ceiling for
*no* ceiling until the next deploy. Shipping that on the strength of a mocked
test, against infrastructure this change could not be exercised on, is the worse
trade. Revisit with a store whose script loading is retried, or when there is a
staging environment with real Memorystore to verify against.

## Outbound requests

One request body on this service names a URL the server then fetches: a Web Push
subscription endpoint. It is guarded in two places (`utils/outboundGuard.js`):

- **At registration** — https only, no IP literals, no internal names. A real
  push service is always a DNS name on the public internet.
- **At send time** — a custom `lookup` on the HTTPS agent re-checks the address
  DNS actually returned, which is the only place a public name pointing at
  `169.254.169.254` can be caught. Stored rows predating the check are re-checked
  before every send and retired if they fail.

Everything else outbound (SMTP, Twilio, FCM, Expo) takes its destination from
configuration, never from a request.

## The browser apps

Both are static and served by Firebase Hosting, so their security headers live in
`firebase.json` — **which is JSON and cannot carry comments, so the reasoning is
here.**

Shared by both: `Content-Security-Policy`, HSTS with `preload`,
`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` and a
`Cross-Origin-Opener-Policy`.

The admin console gets the strict policy — `script-src 'self'`, `frame-src
'none'`, `frame-ancestors 'none'`, `connect-src` limited to itself and the API.
It has no third-party anything.

The family app has to be looser in two places, both real:

- `script-src` includes `'unsafe-inline'` because `landing.html` and
  `contact.html` carry inline `<script>` and `<style>` blocks. Hashes were the
  alternative and were rejected: Firebase Hosting is static, so there are no
  nonces, and a hash silently breaks the marketing page on the next copy edit.
  What the directive still buys is real — no external script host, and no `eval`.
- `connect-src`, `img-src`, `frame-src` **and `style-src`** name Google Sign-In,
  Google Maps, OpenStreetMap tiles, Nominatim and Pexels, because the app
  genuinely uses them. `accounts.google.com` in `style-src` is the easy one to
  miss and was missed on the first draft: Google Identity Services pulls
  `accounts.google.com/gsi/style`, so without it the button renders unstyled —
  in production only.

**If you change an origin, change the CSP.** Pointing `VITE_MAP_TILE_URL` at a
different tile provider, moving the API off `api.parentix.ca`, or adding a
third-party script will be blocked in production and work perfectly under `npm
run dev`, because the dev server serves none of these headers.

**Verify it the way the policy is actually enforced**, which is not by reading
it. Serve `dist/` from a local server that sets the header from `firebase.json`,
load the real pages in a browser, and collect `Refused to…` console messages —
and separately drive the third-party paths a logged-out page never reaches:
inject `accounts.google.com/gsi/client` and call `renderButton`, load
`maps.googleapis.com/maps/api/js`, and mount a Leaflet layer against the tile
host. The GSI stylesheet above was found that way and by nothing else.

**Session tokens live in `localStorage`** (`packages/shared/src/api/client.js`),
under a per-app key so the console and the family app never share a session. This
is the usual SPA trade: `HttpOnly` cookies would move the risk from XSS to CSRF
and require a cross-origin cookie story between Firebase Hosting and Cloud Run.
The CSP above is the compensating control, and there are no `dangerouslySetInnerHTML`
or `innerHTML` sinks taking user data in either app.

## The apps on devices

- **Child app (React Native).** The device token is in `expo-secure-store`
  (Keystore / Keychain). Backup is off — `allowBackup="false"` plus
  `data_extraction_rules.xml`, which is what covers device-to-device transfer on
  Android 12+. The exported components are exported because the OS requires it:
  the accessibility service is guarded by `BIND_ACCESSIBILITY_SERVICE`, the VPN
  service by `BIND_VPN_SERVICE`, and `BootReceiver` checks its action before
  doing anything. OTA updates are disabled.
- **Family app (Capacitor).** Same backup treatment, and it matters more here:
  the WebView's `localStorage` holds the parent's JWT inside the backed-up data
  directory.
- **Desktop agent (Electron).** `contextIsolation: true`, `nodeIntegration:
  false`, `sandbox: true`, `file://` only, CSP in the document. State is sealed
  with `safeStorage` (DPAPI / Keychain) and written atomically into a `0700`
  directory. A renderer with Node in it would be a way to switch the agent off
  from a page it already has open.

## Infrastructure

- The uploads bucket is private with `public_access_prevention = "enforced"`.
  Objects are written through short-lived signed PUT URLs whose keys are
  **server-generated** (`services/storage.js`), so a caller cannot write outside
  its own prefix or overwrite another tenant's object. `contentType` is bound
  into the signature and restricted to three image types.
- Cloud SQL has no authorized networks and `ssl_mode = "ENCRYPTED_ONLY"`.
  Production reaches it over the Cloud Run Unix socket, which never leaves the
  instance sandbox.
- Service-account roles are individually scoped (`iam.tf`) — no project-level
  editor anywhere. Cloud Run is `allUsers`-invokable because Stripe and the child
  app must reach it without a Google identity; `routes/tasks.js` therefore does
  its own OIDC verification of issuer, audience *and* service-account email.
- The API image is multi-stage, production dependencies only, runs as `node`
  (uid 1000) under `tini`.
- Production refuses to boot on a weak `JWT_SECRET`, a malformed field key, a
  missing Postgres connection, a missing CORS origin, missing SMTP credentials,
  or `SMS_ECHO_CODE` being set (`config/env.js` → `assertProductionConfig`).

### Database TLS over TCP

`DB_SSL` with no CA means the connection is encrypted and the server is not
verified. Set `DB_SSL_CA` to the instance's server certificate and verification
turns on by itself:

```bash
gcloud sql instances describe <instance> --format='value(serverCaCert.cert)' \
  | gcloud secrets versions add parentix-<env>-db-ssl-ca --data-file=-
```

Until then the API logs a warning on every production boot. This does not apply
to the socket path, which is the recommended topology.

## Auditing

`utils/auditLogger.js` records every privileged and destructive action with the
actor, the entity, the IP and the user agent. Deleting monitoring records is
audited specifically — a parental control where an alert or a browsing entry can
be made to vanish without trace is a different product from one where it cannot.
The audit row for an account deletion deliberately outlives the account and
carries the fact but not the personal data.

## Known and accepted

- **`localStorage` sessions** — see above.
- **`'unsafe-inline'` in the family app's `script-src`** — see above.
- **Per-instance rate limits** — see above.
- **`uuid` advisory GHSA-w5hq-g745-h8pq** (moderate, transitive under
  `sequelize`, `gaxios`, `@google-cloud/storage`). Needs a `buf` argument passed
  to `uuid` v3/v5/v6; nothing in this tree does that, and npm's only "fix" is a
  downgrade to `sequelize@3`. Left; recheck when the upstreams bump.
- **`react-router` GHSA-wrjc-x8rr-h8h6 / GHSA-337j-9hxr-rhxg** (moderate). The
  first needs a user-controlled `to` / `navigate()` target — every route in both
  apps comes from a static table in `navigation.js`. The second is SSR hydration
  only, and both apps are client-rendered. Not upgraded to v7 in a security pass
  because the advisories are unreachable and the major is not.
- **`esbuild`/`vite` and `tar`/`@capacitor/cli`** — build-time only. The esbuild
  advisory is about the dev server, which is never deployed.
- **DNS-level web filtering is bypassable** by design limits, not by defect: a
  child using DoH or a VPN is not filtered. The product should not claim
  otherwise.

## Reporting

Security issues to the address in `ADMIN_EMAIL`. Please do not open a public
issue.
