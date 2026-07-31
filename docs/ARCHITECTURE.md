# Architecture

## System shape

```
                        ┌──────────────────────────────────────┐
   Parent (browser) ───▶│ app.parentix.ca                      │
                        │  /            → GCS bucket + CDN     │
                        │  /api/*       → Cloud Run            │
                        │  /socket.io/* → Cloud Run            │
                        └──────────────┬───────────────────────┘
                                       │
   Staff (browser) ────▶┌──────────────┴───────────────────────┐
                        │ admin.parentix.ca                    │
                        │  /            → GCS bucket + CDN     │
                        │  /api/*       → Cloud Run            │
                        └──────────────┬───────────────────────┘
                                       │   (one global external
                                       │    Application LB, one
   Child device ───────────────────────┼───▶ anycast IP, three hosts)
                                       │         │
                                       └─────────┤ api.parentix.ca
                                                 ▼
                                   ┌──────────────────────────┐
                                   │ Cloud Run: Parentix API  │
                                   │ 1-6 instances, autoscaled│
                                   └───┬──────┬──────┬────────┘
                                       │      │      │
                    Cloud SQL Postgres ┘      │      └ SMTP relay (transactional mail)
                    (Unix socket, Auth Proxy) │
                                     Memorystore Redis
                                     (Socket.IO fan-out, via VPC connector)
```

### Why the load balancer fronts the API

Both web apps are served from the same load balancer that routes `/api/*` and
`/socket.io/*` to Cloud Run. The browser therefore sees a single origin, which
means:

- no CORS preflight on the hot path;
- the apps never have to be rebuilt when the backend URL changes — `VITE_API_URL`
  stays empty in production;
- the static marketing pages can call `/api/contact` with a relative URL.

The child app is not a browser and has no such constraint, so it talks to
`api.parentix.ca` directly.

The API still validates `Origin`: a request is accepted when the origin is on the
configured allowlist **or** matches the host the request arrived on. The second
rule is what makes a same-origin request work through a freshly created load
balancer without a redeploy — and it grants nothing that a same-origin request
did not already have.

## How things connect

| From | To | Path |
| --- | --- | --- |
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
| `storage.tf` | uploads bucket + two web buckets |
| `registry.tf` | Artifact Registry |
| `secrets.tf` | Secret Manager: generated and supplied |
| `iam.tf` | the API service account and its grants |
| `run.tf` | the Cloud Run service |
| `loadbalancer.tf` | NEG, backends, URL map, certificate, forwarding rules |
| `dns.tf` | Cloud DNS *(optional)* |

Sizing lives in `envs/dev.tfvars` and `envs/prod.tfvars`.

## Request lifecycle

1. The load balancer matches host and path against the URL map. Static paths go
   to a backend bucket through Cloud CDN; `/api/*` and `/socket.io/*` go to the
   serverless NEG uncached.
2. Cloud Run routes to an instance, starting one if none is warm. Session
   affinity keeps a Socket.IO client on one instance across its polling
   handshake.
3. Express assigns a request id, applies Helmet, CORS, compression and rate
   limits, then dispatches to a router.
4. Handlers `next(err)` on failure. The central error handler logs 5xx with the
   request id and returns a generic message in production, so Sequelize text and
   stack frames never reach a client.

## Authentication

Authentication is entirely the application's own — there is no Identity Platform,
no Firebase Auth, and nothing was migrated from a cloud provider, because nothing
ever lived in one.

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
