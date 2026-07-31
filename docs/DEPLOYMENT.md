# Deployment

Parentix runs on Google Cloud: Cloud Run for the API, Cloud SQL for PostgreSQL,
Cloud Storage behind Cloud CDN for the two web apps.

There is also a [single-VM alternative](../deploy/single-host/README.md) that
trades resilience for about a fifth of the cost.

## Prerequisites

| Tool | Why |
| --- | --- |
| `gcloud` | authentication, Cloud Run deploys, CDN invalidation |
| `terraform` ≥ 1.6 | infrastructure |
| `docker` | building the API image |
| `git` | image tags are commit SHAs |
| Node 20+ | building the web apps |

```bash
gcloud auth login
gcloud auth application-default login     # Terraform reads these separately
gcloud config set project parentix-504103
```

Billing must be enabled on the project. Terraform enables the APIs it needs
itself, which takes a few minutes on the first apply.

All commands take `ENV_NAME` (`dev` or `prod`) and default to `prod`.

---

## 1. One-time setup

### 1.1 Choose an environment

`infrastructure/gcp/envs/dev.tfvars` and `prod.tfvars`. The differences that
matter:

| | dev | prod |
| --- | --- | --- |
| Cloud Run min instances | 0 (scales to zero) | 1 |
| Cloud SQL | `db-f1-micro`, zonal | `db-custom-1-3840`, regional |
| Redis | off | on |
| Load balancer + custom domain | no | yes |
| Deletion protection | off | on |

Deploy `dev` first. It exercises the whole pipeline for roughly $10/month and
nothing in it is hard to delete.

### 1.2 Set the domain (prod)

Edit `prod.tfvars` before the first apply:

```hcl
domain = "parentix.ca"
```

Changing this later replaces the managed certificate and the URL map, which means
a window where the old hostnames stop resolving. Cheap to get right up front.

### 1.3 Deploy the infrastructure

```bash
./infrastructure/gcp/deploy.sh dev plan
./infrastructure/gcp/deploy.sh dev apply
```

The project (`parentix-504103`) comes from `envs/<env>.tfvars`, so it cannot
drift with whatever `gcloud config` happens to be set to. Override with
`PROJECT_ID=...` to target a scratch project.

State goes to `gs://parentix-504103-parentix-tfstate`, created on first run with
versioning enabled. Each environment is a Terraform workspace, so `dev` and
`prod` never share state.

### 1.4 Point DNS at the load balancer

`parentix.ca` is registered with GoDaddy and its nameservers stay there —
`manage_dns = false`, so Terraform creates no zone and you add the records by
hand.

```bash
terraform -chdir=infrastructure/gcp output -raw load_balancer_ip
```

In **GoDaddy → My Products → parentix.ca → DNS → Manage Zones**, add three A
records pointing at that address:

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| A | `app` | *(load balancer IP)* | 600 |
| A | `admin` | *(load balancer IP)* | 600 |
| A | `api` | *(load balancer IP)* | 600 |

Only subdomains are used, so nothing needs to touch the apex record — which is
the awkward case at registrars that do not support ALIAS/ANAME.

Confirm propagation before moving on:

```bash
for h in app admin api; do dig +short "$h.parentix.ca"; done
```

The managed certificate stays in `PROVISIONING` until **all three** resolve —
usually 15–60 minutes, occasionally several hours:

```bash
gcloud compute ssl-certificates describe parentix-prod-cert --global \
  --format='value(managed.status,managed.domainStatus)'
```

Nothing works over HTTPS until this reads `ACTIVE`. If one hostname is stuck at
`FAILED_NOT_VISIBLE`, its A record is wrong or has not propagated — fix it and
wait; the certificate retries on its own.

### 1.4a Mail authentication records

Also at GoDaddy, and easy to forget until password-reset emails start landing in
spam. Sending as `no-reply@parentix.ca` through a third-party relay means the
domain has to authorise that relay:

| Type | Name | Value |
| --- | --- | --- |
| TXT | `@` | `v=spf1 include:<relay's SPF host> ~all` |
| CNAME | *(relay-specific)* | provided by the relay when you verify the domain |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:you@parentix.ca` |

The exact SPF include and DKIM CNAMEs come from whichever relay you pick —
SendGrid, Mailgun and Postmark all walk you through "domain authentication" and
print the records to add.

Start DMARC at `p=none` so you get reports without silently dropping your own
mail, then tighten to `p=quarantine` once the reports look clean.

> If GoDaddy also hosts mailboxes on `parentix.ca` (Microsoft 365 is the usual
> bundle), do **not** replace the existing SPF record — a domain may have only
> one, and a second breaks both. Merge the relay's `include:` into the record
> that is already there.

### 1.5 Supply the external credentials

Terraform creates the secret containers with an empty placeholder so the service
can boot. Add the real values as new versions:

```bash
ENV=prod
printf 'sk_live_…'         | gcloud secrets versions add parentix-$ENV-stripe-secret-key --data-file=-
printf 'whsec_…'           | gcloud secrets versions add parentix-$ENV-stripe-webhook-secret --data-file=-
printf 'price_…'           | gcloud secrets versions add parentix-$ENV-stripe-premium-price-id --data-file=-
printf 'price_…'           | gcloud secrets versions add parentix-$ENV-stripe-family-price-id --data-file=-
printf 'smtp.sendgrid.net' | gcloud secrets versions add parentix-$ENV-smtp-host --data-file=-
printf 'apikey'            | gcloud secrets versions add parentix-$ENV-smtp-user --data-file=-
printf 'SG.…'              | gcloud secrets versions add parentix-$ENV-smtp-pass --data-file=-
```

Cloud Run reads `latest`, so redeploy the API afterwards. Terraform keeps
managing only version 1 and will not overwrite these.

`JWT_SECRET`, `FIELD_ENCRYPTION_KEY` and the database password are generated by
Terraform — you never need to see them.

> **Email needs a decision.** Google Cloud has no SES. Until `smtp-host` holds a
> real value the API logs emails instead of sending them, which means password
> reset and email verification cannot complete. Any relay works: SendGrid,
> Mailgun, Postmark, Resend, Google Workspace. Note that Compute Engine blocks
> outbound port 25 — use 587.

### 1.6 Create the first staff account

The Admin Dashboard has no sign-up. Run the bootstrap script through the Cloud
SQL Auth Proxy:

```bash
cloud-sql-proxy "$(terraform -chdir=infrastructure/gcp output -raw sql_connection_name)" &

cd services/api
DATABASE_URL="postgresql://parentix:$(gcloud secrets versions access latest \
  --secret=parentix-prod-db-password)@127.0.0.1:5432/parentix" \
  node scripts/create-admin.js --email you@example.com --name "Your Name"
```

The generated password prints once.

### 1.7 Point Stripe at the webhook

```bash
terraform -chdir=infrastructure/gcp output -raw stripe_webhook_url
```

Register that endpoint in the Stripe dashboard, then store the signing secret as
`parentix-<env>-stripe-webhook-secret`.

---

## 2. Releasing

### 2.1 API

```bash
ENV_NAME=prod ./scripts/deploy-api.sh
```

Builds `services/api` for `linux/amd64`, pushes to Artifact Registry tagged with
the current commit, deploys the revision, and checks `/api/health`. Migrations
run at container start; a revision that fails to migrate fails its startup probe
and never receives traffic.

### 2.2 Web apps

```bash
ENV_NAME=prod ./scripts/deploy-web.sh          # both
ENV_NAME=prod ./scripts/deploy-web.sh family   # one
```

Builds, syncs to the bucket, and invalidates the CDN. Hashed assets get a
one-year cache; HTML entry points get `max-age=0`, or a browser keeps loading the
previous build's script tags.

### 2.3 Child app

```bash
cd apps/child-app
EXPO_PUBLIC_API_URL=https://api.parentix.ca/api npx expo run:android --variant release
```

Values are inlined at build time, so a new API hostname means a new build and a
new Play release.

### 2.4 Order that matters

1. **Infrastructure** before anything that reads a Terraform output.
2. **API** before web, when a release adds an endpoint the front end calls.
3. **Web** before API, when a release removes one.
4. **Child app** last, and remember old versions stay installed on real devices —
   the API must keep accepting them.

### 2.5 Before you release

```bash
npm test && npm run test:e2e && npm run lint && npm run build
```

---

## 3. Verifying a release

```bash
API=$(terraform -chdir=infrastructure/gcp output -raw api_url)

curl -fsS "$API/api/health"
curl -fsS -o /dev/null -w '%{http_code}\n' "$(terraform -chdir=infrastructure/gcp output -raw app_url)"
```

Then, in a browser: sign in as a parent, open a page that uses realtime (the
socket should connect, not fall back to polling forever), sign in to the admin
console, and confirm a password-reset email actually arrives.

```bash
gcloud run services logs read parentix-prod-api --region us-central1 --limit 50
```

---

## 4. Rolling back

```bash
# API — redeploy a previous image tag (tags are commit SHAs)
IMAGE_TAG=<old-sha> ENV_NAME=prod ./scripts/deploy-api.sh

# or shift traffic to the previous revision without a rebuild
gcloud run services update-traffic parentix-prod-api \
  --region us-central1 --to-revisions <revision>=100

# Web — rebuild from the previous commit and re-run the deploy
git checkout <old-sha> -- apps packages
ENV_NAME=prod ./scripts/deploy-web.sh
```

**Migrations do not roll back automatically.** A revision rollback restores the
old code against the new schema. Write migrations to be additive — add columns,
do not drop them in the same release that stops using them.

---

## 5. Cost notes

| | dev | prod |
| --- | --- | --- |
| Cloud Run | ~$0 (scales to zero) | ~$15–40 |
| Cloud SQL | ~$9 | ~$50 |
| Memorystore | — | ~$35 |
| VPC connector | — | ~$9 |
| Load balancer | — | ~$18 |
| Storage + CDN | ~$1 | ~$5 |
| **Total** | **~$10–15** | **~$130–160** |

The three biggest levers, in order:

1. `redis_enabled = false` — also removes the VPC connector, so about $44.
2. `db_availability_type = "ZONAL"` — roughly halves the database cost.
3. `api_min_instances = 0` — free when idle, at the price of a cold start.

Set a budget alert; none of this caps itself.
