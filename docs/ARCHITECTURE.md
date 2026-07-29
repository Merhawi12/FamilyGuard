# Architecture

## System shape

```
                        ┌──────────────────────────────┐
   Parent (browser) ───▶│ CloudFront: Family App       │
                        │  /            → S3 (static)  │
                        │  /media/*     → S3 (uploads) │
                        │  /api/*       → ALB          │
                        │  /socket.io/* → ALB          │
                        └──────────────┬───────────────┘
                                       │
   Staff (browser) ────▶┌──────────────┴───────────────┐
                        │ CloudFront: Admin Dashboard  │
                        │  /            → S3 (static)  │
                        │  /api/*       → ALB          │
                        └──────────────┬───────────────┘
                                       │
   Child device ───────────────────────┼──────▶ ALB (api.parentix.ca)
                                       │         │
                                       └─────────┤
                                                 ▼
                                   ┌──────────────────────────┐
                                   │ ECS Fargate: Parentix API│
                                   │ private subnets, 2+ tasks│
                                   └───┬──────┬──────┬────────┘
                                       │      │      │
                          RDS Postgres ┘      │      └ SES (transactional mail)
                          (isolated)          │
                                   ElastiCache Redis
                                   (Socket.IO fan-out)
```

### Why CloudFront fronts the API

Both web apps are served from the same distribution that proxies `/api/*` and
`/socket.io/*`. The browser therefore sees a single origin, which means:

- no CORS preflight on the hot path;
- the apps never have to be rebuilt when the load balancer's DNS name changes —
  `VITE_API_URL` stays empty in production;
- the static marketing pages can call `/api/contact` with a relative URL.

The child app is not a browser and has no such constraint, so it talks to the
load balancer directly.

The API still validates `Origin`: a request is accepted when the origin is on
the configured allowlist **or** matches the host the request arrived on. The
second rule is what makes a same-origin request through a freshly created
distribution work without a redeploy — and it grants nothing that a same-origin
request did not already have.

## Network

| Subnet tier            | Contents                  | Internet route      |
| ---------------------- | ------------------------- | ------------------- |
| public                 | Application Load Balancer | Internet gateway    |
| private (with egress)  | Fargate tasks             | Outbound via NAT    |
| isolated               | RDS, ElastiCache          | None                |

The database and cache accept traffic only from the application subnets' CIDR
ranges. Those subnets contain nothing but the API tasks and have no inbound
route from the internet.

> Access is granted by CIDR rather than by referencing the API's security group
> because the API stack already depends on the data stack for the database
> endpoint. Pointing back the other way would make the two stacks mutually
> dependent, which CloudFormation cannot deploy.

## Stacks

`infrastructure/aws` synthesises five stacks, deployed in this order:

1. **Network** — VPC, subnets, NAT, S3 gateway endpoint.
2. **Data** — RDS Postgres, ElastiCache Redis, and the application secret.
3. **Storage** — three S3 buckets (family app, admin app, user uploads) plus the
   CloudFront read policy.
4. **Api** — ECR repository, ECS cluster, Fargate service, ALB, autoscaling, IAM.
5. **Web** — the two CloudFront distributions and their URL-rewrite functions.

Environment sizing lives in `infrastructure/aws/lib/config.ts`; select with
`cdk deploy -c env=dev|prod`.

## Request lifecycle

1. CloudFront matches the path against its behaviours. Static paths are served
   from S3; `/api/*` and `/socket.io/*` are forwarded to the ALB uncached, with
   all headers, cookies and query strings preserved.
2. The ALB routes to a healthy Fargate task (`GET /api/health`). Cookie
   stickiness keeps a Socket.IO client on one task across its polling handshake.
3. Express assigns a request id, applies Helmet, CORS, compression and rate
   limits, then dispatches to a router.
4. Handlers `next(err)` on failure. The central error handler logs 5xx with the
   request id and returns a generic message in production, so Sequelize text and
   stack frames never reach a client.

## Authentication

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

1. takes a Postgres advisory lock, so simultaneously starting tasks serialise;
2. runs `sequelize.sync()`, which only ever creates missing tables;
3. applies pending Umzug migrations, tracked in the `migrations` table.

Migrations handle what `sync()` cannot do safely: adding a column to a table
that already exists, creating indexes, and backfilling data. They live in
`services/api/src/db/migrations` and are written to be idempotent.

## File storage

Uploads never pass through the API. The client asks for a pre-signed S3 `PUT`
URL, sends the bytes straight to S3, then saves the returned URL on the record.

Two rules keep that safe:

- keys are **server-generated** as `child-avatars/<parentId>/<uuid>.<ext>`, so a
  caller cannot choose where it writes;
- a URL arriving in a request body is only stored if it resolves to a key under
  the caller's own prefix. Without that check a caller could name another
  tenant's object and have the replace-cleanup delete it.

## Realtime

Socket.IO events (alerts, chat, location, activity) fan out across tasks through
the Redis adapter. Without it a parent connected to one task would never receive
an event emitted by another, capping the service at a single task. With
`REDIS_URL` unset — local development and tests — the in-memory adapter is used
and everything else behaves identically.

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
