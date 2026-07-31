# Parentix

Parental control and digital safety platform. Three applications share one API:

| Application         | Path                     | What it is                                                            |
| ------------------- | ------------------------ | --------------------------------------------------------------------- |
| **Admin Dashboard** | `apps/admin-dashboard`   | Staff console — users, billing, sessions, settings, audit logs         |
| **Family App**      | `apps/family-app`        | Parent-facing dashboard plus the public marketing site                 |
| **Child App**       | `apps/child-app`         | The monitored Android device agent (Expo + native modules)             |
| API                 | `services/api`           | Express + Sequelize + Socket.IO backend, runs on Cloud Run             |

## Repository layout

```
apps/
  admin-dashboard/     React + Vite  → Cloud Storage + Cloud CDN
  family-app/          React + Vite  → Cloud Storage + Cloud CDN
  child-app/           Expo (React Native) + Kotlin native modules
services/
  api/                 Express, Sequelize, Socket.IO  → Artifact Registry → Cloud Run
packages/
  shared/              API client, auth/realtime contexts, UI primitives, Tailwind preset
infrastructure/
  gcp/                 Terraform — Cloud Run, Cloud SQL, Memorystore, GCS, load balancer, Secret Manager
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

Requires Node 20+ and Docker (for local Postgres and Redis).

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
`VITE_API_URL` stays empty locally.

With `EMAIL_PROVIDER=none` no mail is sent — signup verification codes and
password-reset links are written to the API log instead.

## Commands

| Command                     | Effect                                            |
| --------------------------- | ------------------------------------------------- |
| `npm run build`             | Production build of both web apps                 |
| `npm run lint`              | ESLint over both web apps, shared, and the API    |
| `npm test`                  | API test suite (Jest + supertest)                 |
| `npm run test:e2e`          | Boots a real server and walks the full workflow   |
| `npm run infra:plan`        | Terraform plan for `$ENV_NAME` (default `dev`)     |
| `npm run infra:deploy`      | Terraform apply for `$ENV_NAME`                   |
| `npm run infra:output`      | Show the Terraform outputs                        |
| `npm --prefix services/api run migrate` | Apply pending database migrations     |

## Deployment

The backend runs on Cloud Run; the web apps are static bundles in Cloud Storage
served through Cloud CDN. One global load balancer fronts all three hostnames and
routes `/api/*` and `/socket.io/*` to Cloud Run, so the browser sees one origin.

```bash
./infrastructure/gcp/deploy.sh prod apply
ENV_NAME=prod ./scripts/deploy-api.sh # build, push, roll the service
ENV_NAME=prod ./scripts/deploy-web.sh # build, sync to GCS, invalidate the CDN
```

Full instructions, including the one-time Google Cloud setup, are in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). For a cheaper single-VM deployment see
[deploy/single-host](deploy/single-host/README.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — how the pieces fit together, on Google Cloud and in the code
- [Deployment](docs/DEPLOYMENT.md) — first-time Google Cloud setup and the release process
- [Operations](docs/OPERATIONS.md) — secrets, migrations, rollback, monitoring, incident response
- [API reference](docs/API.md) — endpoints, auth model, realtime events
