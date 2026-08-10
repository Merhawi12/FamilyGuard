# Parentix

Parental control and digital safety platform. Three applications share one API:

| Application         | Path                     | What it is                                                            |
| ------------------- | ------------------------ | --------------------------------------------------------------------- |
| **Admin Dashboard** | `apps/admin-dashboard`   | Staff console — users, devices, billing, sessions, settings, audit logs |
| **Family App**      | `apps/family-app`        | Parent-facing dashboard plus the public marketing site                 |
| **Child App**       | `apps/child-app`         | The monitored Android device agent (Expo + native modules)             |
| API                 | `services/api`           | Express + Sequelize + Socket.IO backend, runs on Cloud Run             |

## Repository layout

```
apps/
  admin-dashboard/     React + Vite  → Firebase Hosting
  family-app/          React + Vite  → Firebase Hosting
  child-app/           Expo (React Native) + Kotlin native modules
services/
  api/                 Express, Sequelize, Socket.IO  → Artifact Registry → Cloud Run
packages/
  shared/              API client, auth/realtime contexts, UI primitives, Tailwind preset
infrastructure/
  gcp/                 Terraform — Cloud Run, Cloud SQL, Memorystore, GCS, load balancer, Secret Manager
firebase.json          Firebase Hosting: two sites, SPA rewrites, cache and security headers
deploy/
  single-host/         Cheaper alternative: the whole stack in Docker on one Compute Engine VM
scripts/               Deployment scripts
docs/                  Architecture, deployment, operations
```

The two web apps and `packages/shared` form an npm workspace, so one `npm install`
at the root covers all three. `services/api` and `apps/child-app` keep their own
lockfiles — the API so its container image builds from a single directory, and
the child app because Metro does not cope well with hoisted dependencies.

## Getting started

Requires Node 20+. Docker is optional — `npm run pg:install` provides a local
PostgreSQL without it.

```bash
# 1. Backing services
docker compose up -d

# 2. Dependencies
npm install                      # shared package + both web apps
npm --prefix services/api ci
npm --prefix apps/child-app ci

# 3. Configuration
cp services/api/.env.example        services/api/.env
cp apps/family-app/.env.example     apps/family-app/.env
cp apps/admin-dashboard/.env.example apps/admin-dashboard/.env
```

Fill in `services/api/.env` — at minimum `JWT_SECRET` and `FIELD_ENCRYPTION_KEY`:

```bash
openssl rand -hex 32                                                  # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # FIELD_ENCRYPTION_KEY
```

Then run each piece in its own terminal:

```bash
npm run dev:api        # http://localhost:5000
npm run dev:family     # http://localhost:3000
npm run dev:admin      # http://localhost:3001
npm run dev:child      # Expo dev server
```

Both web dev servers proxy `/api` and `/socket.io` to the API, so
`VITE_API_URL` stays empty locally. In production it names the API host —
Firebase Hosting serves the apps and Cloud Run serves the API, so the two are
different origins and the value is compiled into the bundle.

With `EMAIL_PROVIDER=none` no mail is sent — signup verification codes and
password-reset links are written to the API log instead.

## Commands

| Command                     | Effect                                            |
| --------------------------- | ------------------------------------------------- |
| `npm run build`             | Production build of both web apps                 |
| `npm run lint`              | ESLint over both web apps, shared, and the API    |
| `npm test`                  | API test suite (Jest + supertest), on in-memory SQLite |
| `npm run test:pg`           | The same suite against PostgreSQL — see below     |
| `npm run test:browser:pg`   | The Chromium suite against PostgreSQL             |
| `npm run pg:start` / `pg:stop` | A local throwaway PostgreSQL 16 — no admin, no Docker |
| `npm run test:e2e`          | Boots a real server and walks the full workflow   |
| `npm run test:browser`      | Drives both web apps in Chromium — see below      |
| `npm run test:all`          | Lint, build, and every suite above                |
| `npm run infra:plan`        | Terraform plan for `$ENV_NAME` (default `dev`)     |
| `npm run infra:deploy`      | Terraform apply for `$ENV_NAME`                   |
| `npm run infra:output`      | Show the Terraform outputs                        |
| `npm --prefix services/api run migrate` | Apply pending database migrations     |

### Testing against PostgreSQL

The default suite runs on in-memory SQLite so it needs no services, but SQLite
and PostgreSQL are not interchangeable and the differences are silent — a `json`
column has no equality operator in Postgres and is plain text in SQLite, and
Postgres resolves operators when it parses a statement, so an incompatibility
fails even against an empty table. A green SQLite run is therefore not evidence
that Cloud SQL will accept the same SQL.

Run both before anything reaches production:

```bash
docker compose up -d postgres     # or any throwaway Postgres

npm --prefix services/api run test:pg \
  # TEST_DATABASE_URL=postgresql://parentix:parentix_secret@127.0.0.1:5432/parentix

E2E_DATABASE_URL=postgresql://parentix:parentix_secret@127.0.0.1:5432/parentix \
  npm run test:e2e
```

Both wipe and recreate the schema, so point them at a throwaway database.

### Testing the web apps

Every other suite tests the API. `npm run test:browser` is the only one that runs
the front ends: it boots the API, serves both `dist/` folders behind a proxy that
reproduces how Firebase Hosting resolves a request — static file first, then the
rewrites in `firebase.json` — and drives Chromium through sign-in, the
alert bell, every dashboard and console route, and the console's role gating —
failing on any console error, uncaught exception or 4xx response.

```bash
npm run build          # it serves dist/, so build first
npm run test:browser
```

A passing `npm run build` only means the bundles compiled. A page that throws on
mount builds perfectly and fails here.

Point it at Postgres the same way as the other suites:

```bash
BROWSER_E2E_DATABASE_URL=postgresql://parentix:parentix_secret@127.0.0.1:5432/parentix \
  npm run test:browser
```

## Deployment

The web apps are published to Firebase Hosting, which supplies the CDN, the
certificates and an atomic release per deploy. The API runs on Cloud Run behind a
global load balancer that fronts `api.parentix.ca` and nothing else, so the two
tiers are separate origins and the API's CORS allowlist is what connects them.

```bash
./infrastructure/gcp/deploy.sh prod apply
ENV_NAME=prod ./scripts/deploy-api.sh # build, push, roll the service
ENV_NAME=prod ./scripts/deploy-web.sh # build both apps, publish to Firebase Hosting
```

Full instructions, including the one-time Google Cloud setup, are in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). For a cheaper single-VM deployment see
[deploy/single-host](deploy/single-host/README.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — how the pieces fit together, on Google Cloud and in the code
- [Deployment](docs/DEPLOYMENT.md) — first-time Google Cloud setup and the release process
- [Operations](docs/OPERATIONS.md) — secrets, migrations, rollback, monitoring, incident response
- [API reference](docs/API.md) — endpoints, auth model, realtime events
