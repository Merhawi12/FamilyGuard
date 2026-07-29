# Parentix

Parental control and digital safety platform. Three applications share one API:

| Application         | Path                     | What it is                                                            |
| ------------------- | ------------------------ | --------------------------------------------------------------------- |
| **Admin Dashboard** | `apps/admin-dashboard`   | Staff console — users, billing, sessions, settings, audit logs         |
| **Family App**      | `apps/family-app`        | Parent-facing dashboard plus the public marketing site                 |
| **Child App**       | `apps/child-app`         | The monitored Android device agent (Expo + native modules)             |
| API                 | `services/api`           | Express + Sequelize + Socket.IO backend, runs on ECS Fargate           |

## Repository layout

```
apps/
  admin-dashboard/     React + Vite  → S3 + CloudFront
  family-app/          React + Vite  → S3 + CloudFront
  child-app/           Expo (React Native) + Kotlin native modules
services/
  api/                 Express, Sequelize, Socket.IO  → ECR → ECS Fargate
packages/
  shared/              API client, auth/realtime contexts, UI primitives, Tailwind preset
infrastructure/
  aws/                 AWS CDK — VPC, RDS, ElastiCache, ECS, ALB, S3, CloudFront, SES
scripts/               Deployment scripts
docs/                  Architecture, deployment, operations
```

The two web apps and `packages/shared` form an npm workspace, so one `npm install`
at the root covers all three. `services/api`, `apps/child-app` and
`infrastructure/aws` keep their own lockfiles — the API so its container image
builds from a single directory, the child app because Metro does not cope well
with hoisted dependencies, and the infrastructure so CDK upgrades stay isolated.

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
| `npm run infra:synth`       | Synthesize the CloudFormation templates           |
| `npm run infra:deploy`      | Deploy all infrastructure stacks                  |
| `npm --prefix services/api run migrate` | Apply pending database migrations     |

## Deployment

The backend runs on ECS Fargate behind an Application Load Balancer; the web
apps are static bundles on S3 served through CloudFront, which also proxies
`/api/*` and `/socket.io/*` to the load balancer so the browser sees one origin.

```bash
ENV_NAME=prod npm run infra:deploy    # first time, and whenever infra changes
ENV_NAME=prod ./scripts/deploy-api.sh # build, push, roll the service
ENV_NAME=prod ./scripts/deploy-web.sh # build, sync to S3, invalidate CloudFront
```

Full instructions, including the one-time AWS setup, are in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — how the pieces fit together, on AWS and in the code
- [Deployment](docs/DEPLOYMENT.md) — first-time AWS setup and the release process
- [Operations](docs/OPERATIONS.md) — secrets, migrations, rollback, monitoring, incident response
- [API reference](docs/API.md) — endpoints, auth model, realtime events
