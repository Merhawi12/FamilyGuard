# Parentix on a single Compute Engine VM

An alternative to the Cloud Run stack in [`infrastructure/gcp`](../../infrastructure/gcp).
Four containers on one VM, roughly **$25–30/month** against **$130–160** for the
managed stack.

```
                    :443
Internet ──▶ caddy ──┬─ app.<domain>    → /srv/family  (+ /api, /socket.io)
                     ├─ admin.<domain>  → /srv/admin   (+ /api, /socket.io)
                     └─ api.<domain>    → api:5000     (the child app talks here)
                                              │
                                    ┌─────────┴─────────┐
                                 postgres              redis
```

Only Caddy publishes ports. Postgres and Redis are reachable solely over the
compose network, so no firewall rule ever needs to expose 5432 or 6379.

## When to pick this over Cloud Run

Cost, and only cost. The managed stack gives you automated database backups,
point-in-time recovery, zero-downtime deploys, autoscaling and no host to patch.
This gives you a cheaper bill and a machine you fully control.

Single VM means no failover: a reboot is downtime, a zone outage is an outage.
That is usually an acceptable trade early on.

**Backups are not.** Cloud SQL backs itself up; a container on a persistent disk
does not. `bootstrap.sh` installs a nightly `pg_dump` timer for exactly this
reason — set `BACKUP_GCS_URI` so a copy leaves the box, and actually run
`restore.sh` once on a throwaway VM before you have real users.

## Provisioning the VM

```bash
gcloud compute addresses create parentix-ip --region us-central1

gcloud compute instances create parentix \
  --zone us-central1-a \
  --machine-type e2-small \
  --image-family debian-12 --image-project debian-cloud \
  --boot-disk-size 30GB --boot-disk-type pd-balanced \
  --address parentix-ip \
  --tags http-server,https-server \
  --scopes cloud-platform
```

- **`e2-small`** (2 GB) is the practical floor. `e2-micro` works only because
  `bootstrap.sh` adds swap, and the frontend build will crawl.
- **A static address** is not optional: an ephemeral IP changes on every stop and
  breaks DNS *and* every child app already installed.
- **`--tags http-server,https-server`** match the default VPC's built-in firewall
  rules. On a custom network, create them:
  ```bash
  gcloud compute firewall-rules create allow-http-https \
    --allow tcp:80,tcp:443 --target-tags http-server,https-server
  ```
- **`--scopes cloud-platform`** lets the instance's service account reach Cloud
  Storage for backups and uploads without a key file on disk.

## DNS

Three A records pointing at the static address, in place *before* the first
deploy — Caddy proves control over HTTP to issue certificates, and repeated
failures hit a Let's Encrypt rate limit:

| Record | Purpose |
|---|---|
| `app.<domain>` | family app + marketing pages |
| `admin.<domain>` | admin dashboard |
| `api.<domain>` | API — hardcoded in the child app |

> The child app runs on Android, which rejects self-signed certificates. A real
> domain with a real certificate is required, not a nicety — without it monitored
> devices silently stop reporting.

## First deploy

```bash
gcloud compute ssh parentix --zone us-central1-a

sudo apt-get update && sudo apt-get install -y git
git clone <repo-url> parentix && cd parentix/deploy/single-host

./bootstrap.sh          # docker, compose, swap, log caps, backup timer
exit                    # log back in so the docker group applies
```

```bash
cd parentix/deploy/single-host
cp .env.example .env && chmod 600 .env

# Generate the three secrets:
openssl rand -base64 24   # POSTGRES_PASSWORD
openssl rand -hex 32      # JWT_SECRET
openssl rand -hex 32      # FIELD_ENCRYPTION_KEY  (must be exactly 64 hex chars)

vi .env                   # set the domains, TLS_EMAIL, and the secrets above
./deploy.sh
```

`deploy.sh` validates `.env`, builds both images, brings up Postgres and Redis,
runs migrations to completion, then starts the app and checks `/api/health`.

Create the first staff account — the admin dashboard has no sign-up:

```bash
docker compose run --rm api node scripts/create-admin.js \
  --email you@example.com --name "Your Name"
```

The generated password prints once.

## Releasing

```bash
./deploy.sh              # pull, rebuild, migrate, restart
./deploy.sh --no-pull    # deploy the working tree as-is
```

There is a few seconds of downtime while containers swap. Zero-downtime deploys
are one of the things the Cloud Run stack gives you for free.

## Operations

```bash
docker compose ps
docker compose logs -f api
docker compose restart api

./backup.sh                                  # on demand
systemctl list-timers parentix-backup        # nightly at 03:17 UTC
./restore.sh /var/backups/parentix/<file>.sql.gz

docker compose exec postgres psql -U parentix -d parentix
```

Snapshot the boot disk on a schedule as well — `pg_dump` covers the database,
not the rest of the machine:

```bash
gcloud compute resource-policies create snapshot-schedule parentix-daily \
  --region us-central1 --max-retention-days 14 --daily-schedule --start-time 04:00
gcloud compute disks add-resource-policies parentix \
  --zone us-central1-a --resource-policies parentix-daily
```

## Still to configure

The app runs without these, but with reduced function:

- **`EMAIL_PROVIDER`** — `none` logs emails instead of sending them, so password
  reset and email verification cannot complete. Google Cloud has no SES
  equivalent; point `SMTP_HOST` at SendGrid, Mailgun, Postmark or Workspace.
  Port 25 is blocked on Compute Engine — use 587.
- **`STORAGE_PROVIDER`** — `none` makes upload endpoints return 503. There is no
  local-disk provider; uploads need a Cloud Storage bucket, and the instance's
  service account needs `roles/iam.serviceAccountTokenCreator` **on itself** to
  sign URLs.
- **Stripe** — set the keys, then point the webhook at
  `https://api.<domain>/api/payments/webhook`.
- **Child app** — rebuild with `EXPO_PUBLIC_API_URL=https://api.<domain>/api` if
  your domain is not `parentix.ca`.

## Moving to the managed stack

Nothing here is one-way. `infrastructure/gcp` builds the API image from the same
[`services/api/Dockerfile`](../../services/api/Dockerfile). Migrating is a
`pg_dump` into Cloud SQL and a DNS change.
