# Deployment

## Prerequisites

- AWS account with permission to create VPC, RDS, ECS, ELB, S3, CloudFront,
  Secrets Manager, SES and IAM resources
- AWS CLI v2, authenticated (`aws sts get-caller-identity` must succeed)
- Docker
- Node 20+

All commands take `ENV_NAME` (`dev` or `prod`) and default to `prod`.

---

## 1. One-time AWS setup

### 1.1 Bootstrap CDK

```bash
npm --prefix infrastructure/aws ci
npm --prefix infrastructure/aws run bootstrap
```

### 1.2 Choose an environment configuration

`infrastructure/aws/lib/config.ts` holds the sizing for each environment. Before
the first production deploy set at least:

- `appUrl` / `adminUrl` — absolute URLs of the two web apps. These end up in
  password-reset emails and in the S3 CORS allowlist, so they must be right.
- `email.fromAddress` — a **verified** SES identity.
- `email.adminAddress` — where contact-form messages go.

Custom domains are optional. Without them everything still works over the
generated CloudFront and ALB hostnames, but the CloudFront → ALB hop is plain
HTTP because there is no certificate to validate. Use domains for production.

### 1.3 Deploy the infrastructure

```bash
ENV_NAME=prod npm run infra:deploy
```

This creates the VPC, database, cache, buckets, ECR repository, ECS service and
CloudFront distributions. The first deploy takes roughly 20–30 minutes, most of
it RDS and CloudFront.

The ECS service will not become healthy yet — there is no image in ECR. That is
expected; continue.

### 1.4 Fill in the application secret

CDK generates `JWT_SECRET` automatically. The rest are created empty and must be
set once:

```bash
SECRET_ID="parentix/prod/app"

aws secretsmanager get-secret-value --secret-id "$SECRET_ID" \
  --query SecretString --output text > /tmp/app-secret.json

# Edit /tmp/app-secret.json:
#   FIELD_ENCRYPTION_KEY  64 hex chars — node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PREMIUM_PRICE_ID, STRIPE_FAMILY_PRICE_ID

aws secretsmanager put-secret-value --secret-id "$SECRET_ID" \
  --secret-string file:///tmp/app-secret.json
rm /tmp/app-secret.json
```

> **`FIELD_ENCRYPTION_KEY` can never be rotated once data exists.** It encrypts
> stored columns; changing it makes every existing encrypted row unreadable.
> Generate it once and back it up somewhere durable.

### 1.5 Verify the SES sending identity

New SES accounts are sandboxed and can only send to verified addresses.

```bash
aws sesv2 create-email-identity --email-identity parentix.ca
aws sesv2 get-account          # check ProductionAccessEnabled
```

Add the DKIM records SES returns to DNS, then request production access from the
SES console. Until that is granted, signup verification and password-reset mail
will only reach verified addresses.

### 1.6 Point Stripe at the webhook

Create an endpoint at `https://<api-domain>/api/payments/webhook` subscribed to
`checkout.session.completed` and `customer.subscription.deleted`, then put its
signing secret into `STRIPE_WEBHOOK_SECRET` (step 1.4).

The route receives its raw body — the signature is checked against the exact
bytes Stripe sent, so it is registered before the JSON body parser.

---

## 2. Releasing

### 2.1 API

```bash
ENV_NAME=prod ./scripts/deploy-api.sh
```

Builds the image, tags it with the current commit, pushes to ECR, updates the
task definition, and waits for the service to stabilise. Migrations run as each
task boots, serialised by a Postgres advisory lock so concurrent starts are safe.

### 2.2 Web apps

```bash
ENV_NAME=prod ./scripts/deploy-web.sh          # both
ENV_NAME=prod ./scripts/deploy-web.sh family   # one
ENV_NAME=prod ./scripts/deploy-web.sh admin
```

Builds, syncs to S3 and invalidates CloudFront. Hashed assets get a one-year
immutable cache; HTML entry points get `max-age=0, must-revalidate`, or browsers
would keep loading the previous build's script tags.

### 2.3 Child app

The Android app is built and distributed separately.

```bash
cd apps/child-app
# Point the bundle at production (values are inlined at build time)
cat > .env <<'EOF'
EXPO_PUBLIC_API_URL=https://api.parentix.ca/api
EXPO_PUBLIC_SOCKET_URL=https://api.parentix.ca
EOF

./android/generate-release-keystore.sh   # first time only — back the result up
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease
```

`keystore.properties` and the keystore itself are git-ignored. Losing the
keystore means losing the ability to ship updates to installed apps.

### 2.4 Order that matters

An API deploy that changes the response shape should go out **before** the web
deploy that depends on it, because the migration runs with the API. In the other
direction — a web change against an unchanged API — order does not matter.

---

## 3. Verifying a release

```bash
API=https://api.parentix.ca

curl -s $API/api/health   # {"status":"ok",...}
curl -s $API/api/ready    # {"status":"ready"} — also proves the DB is reachable

aws ecs describe-services --cluster parentix-prod \
  --services parentix-api-prod \
  --query 'services[0].{running:runningCount,desired:desiredCount,deployments:length(deployments)}'
```

`deployments: 1` means the rollout finished. Then load the Family App, sign in,
and confirm the dashboard populates and the alert bell connects — a working
Socket.IO connection is the clearest end-to-end signal, since it exercises
CloudFront, the ALB, the task, the JWT and the database in one go.

---

## 4. Rolling back

```bash
# API: redeploy a previous image tag (tags are commit SHAs)
IMAGE_TAG=<previous-sha> ENV_NAME=prod ./scripts/deploy-api.sh

# Web: rebuild from the previous commit and re-run the deploy
git checkout <previous-sha> -- apps packages
ENV_NAME=prod ./scripts/deploy-web.sh
```

The ECS deployment circuit breaker also rolls back automatically when a new task
set never passes its health check.

Rolling back **across a migration** needs care: `npm --prefix services/api run
migrate:down` reverts one migration at a time, and only the ones with a `down`.
Take an RDS snapshot before any release containing a destructive migration.

---

## 5. Cost notes

The prod defaults run roughly: 2 NAT gateways, a Multi-AZ `t4g.small` RDS
instance, a `cache.t4g.micro` Redis node, and 2–6 Fargate tasks at 1 vCPU.

The cheapest meaningful reductions, in order:

1. `natGateways: 1` — halves the NAT bill, at the cost of an AZ-level SPOF for
   outbound traffic.
2. `database.multiAz: false` — halves the RDS bill, at the cost of failover.
3. `redis.enabled: false` — only viable with `desiredCount: 1`, since realtime
   events would otherwise not cross tasks.

The `dev` configuration already applies all three.
