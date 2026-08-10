# Architecture

## System shape

```
                     ┌───────────────────────────────┐
   Parent  ─────────▶│ Firebase Hosting — family     │
   (browser)         │   parentix.ca                 │
                     │   www.parentix.ca             │
                     │   app.parentix.ca             │──┐
                     │   parentix-4be0d.web.app      │  │
                     └───────────────────────────────┘  │
                                                        │ XHR + WebSocket,
                     ┌───────────────────────────────┐  │ cross-origin
   Staff   ─────────▶│ Firebase Hosting — admin      │  │
   (browser)         │   admin.parentix.ca           │──┤
                     │   parentix-admin.web.app      │  │
                     └───────────────────────────────┘  │
                                                        ▼
   Child device ──────────────────────────▶ ┌──────────────────────────┐
   (Android, direct)                        │ Global external HTTPS LB │
                                            │   api.parentix.ca        │
                                            └────────────┬─────────────┘
                                                         ▼
                                            ┌──────────────────────────┐
                                            │ Cloud Run: Parentix API  │
                                            │ 1-6 instances, autoscaled│
                                            └───┬──────┬──────┬────────┘
                                                │      │      │
                             Cloud SQL Postgres ┘      │      └ SMTP relay
                             (Unix socket, Auth Proxy) │        (transactional mail)
                                              Memorystore Redis
                                              (Socket.IO fan-out, via VPC connector)
```

### Why the web tier and the API are separate origins

Firebase Hosting serves the two static bundles. The load balancer fronts the API
and nothing else. So every browser call is cross-origin, and the API's CORS
allowlist — not routing — is what decides who may talk to it.

Firebase Hosting *can* rewrite `/api/**` to Cloud Run, which would put both back
on one origin. It is not used here, for three reasons, in order of how much they
cost you:

1. **It does not proxy a websocket upgrade.** Socket.IO would be held down to
   long-polling for every parent, permanently.
2. **It strips every cookie except `__session`.** Cloud Run's session affinity is
   cookie-based, and that affinity is what keeps a Socket.IO polling handshake on
   one instance. Losing it breaks the handshake intermittently above one
   instance — the hardest class of bug to see in production.
3. **It adds a proxy hop.** Express is configured for exactly one
   (`TRUST_PROXY=1`), so rate limiting and audit logs would start keying off an
   edge address instead of the caller's.

The cost of the separation is one CORS preflight per distinct request shape,
cached by the browser for the preflight max-age. That is the cheaper trade.

Consequences worth knowing:

- `VITE_API_URL` is baked into the bundle at build time, so changing the API
  hostname means a rebuild and a redeploy of both apps.
- One deployment answers on several origins. The Family App site carries the
  apex, `www` and `app.` — four names counting `.web.app` — and each is a
  separate `Origin` header. `local.cors_origins` in `infrastructure/gcp/main.tf`
  derives the list; `CLIENT_URL`, `ADMIN_URL` and `CORS_ORIGINS` carry it to the
  service.
- The child app is not a browser and has no such constraint. It talks to
  `api.parentix.ca` directly and always has.

The API accepts an origin only if it is on that allowlist. There is no
same-origin fallback any more — nothing is same-origin — so a hostname nobody
told the API about fails visibly at the browser rather than working by accident.
`services/api/tests/cors.test.js` pins both halves of that.

### Why the marketing page is not `index.html`

Firebase Hosting resolves a static file before it consults any rewrite, and a
request for `/` is answered by `index.html` whenever one exists. The Family App
build therefore emits its React shell as `app.html`
(`apps/family-app/vite.config.js`), leaving no `index.html` for `/` to match, so
the `/` → `landing.html` rewrite in `firebase.json` is what runs. Without that,
`https://parentix.ca/` would serve an empty SPA shell that redirects itself to
the marketing page — a flash of nothing for a visitor and a redirect for the
crawler reading `public/sitemap.xml`, which names `/` as the home page.

Both CI and `scripts/deploy-web.sh` assert the layout, because the failure is a
deploy that succeeds and serves the wrong thing at the most visible URL on the
site.

## How things connect

| From | To | Path |
| --- | --- | --- |
| Internet | web apps | Firebase Hosting (its own CDN and certificates) |
| Internet | Cloud Run | Load balancer → serverless NEG |
| Cloud Run | Cloud SQL | Unix socket at `/cloudsql/<connection-name>`, via the Auth Proxy |
| Cloud Run | Memorystore | Serverless VPC Access connector → peered VPC |
| Cloud Run | Cloud Storage | Google APIs, authenticated by the service account |
| Cloud Run | SMTP relay | Public internet, port 587 |

Cloud SQL has **no authorized networks**. Its public endpoint exists, but with an
empty allow-list nothing on the internet can open a session — access is
exclusively through the Auth Proxy, which authenticates with IAM. That is why
the database needs no VPC and no firewall rule.

The VPC exists *only* to reach Memorystore, which has no public endpoint. With
`redis_enabled = false` no network resources are created at all.

## Terraform layout

`infrastructure/gcp` is one configuration with a workspace per environment.
Files are split by concern rather than by deployment order — Terraform resolves
ordering from the dependency graph:

| File | Contents |
| --- | --- |
| `main.tf` | locals, API enablement |
| `network.tf` | VPC, subnet, VPC connector, private service access *(only with Redis)* |
| `database.tf` | Cloud SQL instance, database, user |
| `redis.tf` | Memorystore *(optional)* |
| `storage.tf` | uploads bucket (the web apps are Firebase Hosting's) |
| `registry.tf` | Artifact Registry |
| `secrets.tf` | Secret Manager: generated and supplied |
| `iam.tf` | the API service account and its grants |
| `run.tf` | the Cloud Run service |
| `loadbalancer.tf` | NEG, API backend, URL map, certificate, forwarding rules |
| `dns.tf` | Cloud DNS for the API hostname *(optional)* |

Firebase Hosting is not in here. Its sites are created once with the Firebase
CLI and its releases are content, not infrastructure — modelling them in
Terraform as well would mean two tools owning one resource. `firebase.json` and
`.firebaserc` at the repository root are the whole of its configuration; the
site IDs are recorded in the tfvars only so the API can be told to accept their
origins.

Sizing lives in `envs/dev.tfvars` and `envs/prod.tfvars`.

## Request lifecycle

1. A page load is answered by Firebase Hosting from its own edge: a static file
   if the path matches one, otherwise the first rewrite in `firebase.json` — the
   marketing page at `/`, the SPA shell everywhere else, always with a 200.
2. An API call goes to `api.parentix.ca`, preceded by a CORS preflight the first
   time that request shape is used. The load balancer has one backend, so
   everything arriving there is forwarded to the serverless NEG uncached.
3. Cloud Run routes to an instance, starting one if none is warm. Session
   affinity keeps a Socket.IO client on one instance across its polling
   handshake.
4. Express assigns a request id, applies Helmet, CORS, compression and rate
   limits, then dispatches to a router.
5. Handlers `next(err)` on failure. The central error handler logs 5xx with the
   request id and returns a generic message in production, so Sequelize text and
   stack frames never reach a client.

## Authentication

Authentication is entirely the application's own — there is no Identity Platform
and no Firebase Authentication, and nothing was migrated from a cloud provider,
because nothing ever lived in one. Using Firebase Hosting does not change this:
Hosting is a static CDN and shares nothing with Firebase Auth. The Firebase
products this platform uses are Hosting and FCM — the latter both directly, for
the parents' Android app, and as the transport Expo push rides on to reach the
child device. Neither touches authentication.

Three token shapes, all signed with the same secret:

| Token          | Claims                     | Issued by                                | Used for                    |
| -------------- | -------------------------- | ---------------------------------------- | --------------------------- |
| Session        | `{ id, sid }`              | login, MFA validation, email verification | Parent and staff requests   |
| Pre-auth       | `{ id, mfaRequired }`      | login when MFA is on (5 min TTL)          | Exchanging for a session    |
| Device         | `{ deviceId, childId }`    | device link confirmation                  | Child app requests          |

`sid` points at a `Session` row, which is what makes an admin force-logout able
to revoke a live token. Every token-issuing path creates one — a bare JWT would
be unrevocable.

Socket.IO authenticates in the handshake and stores the decoded identity on
`socket.data`. Room membership is derived from that identity alone, so a client
cannot join another family's room by supplying an id. A pre-auth token is
rejected outright.

## Data layer

Sequelize models are the source of truth for table shape. On boot the API:

1. takes a Postgres advisory lock, so simultaneously starting instances serialise;
2. runs `sequelize.sync()`, which only ever creates missing tables;
3. applies pending Umzug migrations, tracked in the `migrations` table.

Migrations handle what `sync()` cannot do safely: adding a column to a table that
already exists, creating indexes, and backfilling data. They live in
`services/api/src/db/migrations` and are written to be idempotent.

Because migrations run at container start, a Cloud Run revision that fails to
migrate fails its startup probe and never receives traffic — the previous
revision keeps serving.

## File storage

Uploads never pass through the API. The client asks for a signed Cloud Storage
`PUT` URL, sends the bytes straight to the bucket, then saves the returned URL on
the record.

Two rules keep that safe:

- keys are **server-generated** as `child-avatars/<parentId>/<uuid>.<ext>`, so a
  caller cannot choose where it writes;
- a URL arriving in a request body is only stored if it resolves to a key under
  the caller's own prefix. Without that check a caller could name another
  tenant's object and have the replace-cleanup delete it.

The signing itself has one non-obvious requirement. V4 signed URLs need a private
key; Application Default Credentials on Cloud Run do not include one, so the
client falls back to the IAM `signBlob` API. That requires the service account to
hold `roles/iam.serviceAccountTokenCreator` **on itself**. Without the grant every
upload fails with a 403 that never mentions signing.

## Realtime

Socket.IO events (alerts, chat, location, activity) fan out across instances
through the Redis adapter. Without it a parent connected to one instance would
never receive an event emitted by another, capping the service at a single
instance. With `REDIS_URL` unset — local development, tests, and the `dev`
environment — the in-memory adapter is used and everything else behaves
identically.

Cloud Run's request timeout is raised to its 60-minute maximum, and the load
balancer backend matches it, because the default 5 minutes would sever every
websocket.

## Push notifications

The socket above only reaches an app that is open. Push is what reaches one that
is not, and there are three transports because there are three clients, each of
which can only be reached one way:

| Client | Transport | Configured by |
|---|---|---|
| Parent, in a browser | Web Push (VAPID) | `vapid-public-key` / `vapid-private-key` secrets |
| Parent, Android app | FCM HTTP v1 | `roles/firebasemessaging.admin` on the API service account |
| Child device | Expo push *(which relays to FCM)* | FCM credentials uploaded to the Expo project |

The parent's Android app cannot use the browser transport even though it renders
the same React code: Capacitor runs it in a WebView, and Android's WebView does
not implement the Push API — `PushManager` is absent — so a subscription cannot
be created there at all. That is what FCM is for, and it is the only route to
that app.

FCM sends are authenticated with Application Default Credentials, so on Cloud Run
there is **no key and no secret**: the IAM role is the credential. `firebase-admin`
is deliberately not used — it is ~50 MB to wrap one authenticated POST, and
`google-auth-library` was already a dependency for verifying Google sign-in.

Every send is best-effort and never fails the request that triggered it: the
alert is already in the database and on the socket, and the notification is the
redundant copy. A token the service rejects outright is retired; one that fails
transiently is counted, and only retired after three consecutive failures.

## Scheduled work

One recurring job: an hourly pass over every active parent looking for risk
patterns. It has two runners, selected by `JOB_RUNNER`:

- `internal` — a `setInterval` in the process. Local development, Docker Compose
  and the single-host deployment.
- `external` — Cloud Scheduler POSTs to `/api/tasks/safety-analysis`. This is
  what Cloud Run uses.

An in-process timer is wrong on Cloud Run in both directions at once. A service
scaled to zero has its CPU throttled between requests, so the timer never fires
and the job silently does not happen; a service scaled out runs a copy on every
warm instance. Scheduler makes it exactly once, on a schedule that holds whether
the service is warm or cold, with a retry and a recorded outcome per run.

The endpoint is not JWT-authenticated — the caller is a service account. It
verifies the OIDC token Scheduler attaches: Google's signature, the audience, and
the sending account's address. All three are needed, because a valid
Google-signed token on its own only proves that *some* Google identity called.
Cloud Run cannot do this check itself, since the service is invokable by
`allUsers` so that Stripe's webhook and the child app can reach it.

## Email

Google Cloud has no equivalent of SES. Mail goes through an external SMTP relay —
SendGrid, Mailgun, Postmark, Resend or Google Workspace. The API speaks plain
SMTP via nodemailer, so switching providers is a credential change, not a code
change.

`EMAIL_PROVIDER=none` logs messages instead of sending them, which is what
development and the test suite use.

## Shared web code

`packages/shared` holds the axios client and its interceptors, the auth and
socket contexts, small UI primitives, and the Tailwind preset. Each app aliases
`@parentix/shared` straight at the source directory so Vite compiles the JSX as
project code rather than treating it as a pre-built dependency.

The two apps deliberately do **not** share a session: each sets its own storage
key (`fg_token` for parents, `px_admin_token` for staff). The Admin Dashboard
additionally passes `allowRole={isStaff}` to `AuthProvider`, so a parent's token
is discarded rather than mounting the console — the API would 403 each call
anyway, but the UI should never render.
