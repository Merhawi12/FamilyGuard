# Parentix infrastructure on Google Cloud

Terraform for the whole platform. One configuration, one workspace per
environment.

```
                       ┌─ app.<domain>   → GCS bucket + Cloud CDN
Internet ─▶ Global LB ─┼─ admin.<domain> → GCS bucket + Cloud CDN
            (anycast)  └─ api.<domain>   → Cloud Run ─┬─ Cloud SQL (Unix socket)
                                                      ├─ Memorystore (VPC, prod)
                                                      └─ Cloud Storage (uploads)
```

`/api/*` and `/socket.io/*` are also routed to Cloud Run from the two app
hostnames, so each front end reaches the API same-origin and needs no CORS.

## What replaced what

| AWS | Google Cloud |
|---|---|
| ECS Fargate | Cloud Run |
| RDS PostgreSQL | Cloud SQL for PostgreSQL |
| ElastiCache | Memorystore for Redis |
| S3 | Cloud Storage |
| CloudFront | Cloud CDN + global external Application LB |
| ALB | the same load balancer |
| ECR | Artifact Registry |
| Secrets Manager | Secret Manager |
| ACM | Google-managed SSL certificates |
| Route 53 | Cloud DNS *(optional)* |
| IAM roles | IAM service accounts |
| CDK (TypeScript) | Terraform |
| **SES** | **no equivalent — an external SMTP relay** |

Two things did **not** move because they were never AWS services: user
authentication is the app's own JWT + session-table implementation, and Stripe
billing is unchanged apart from the webhook URL.

## Prerequisites

```bash
gcloud auth login
gcloud auth application-default login     # Terraform reads these
gcloud config set project parentix-4be0d
```

Terraform ≥ 1.6, the gcloud CLI, and Docker for image builds. Billing must be
enabled on the project — `terraform apply` enables the ~16 APIs it needs itself.

### Or use Cloud Shell

[Cloud Shell](https://shell.cloud.google.com) already has gcloud, Terraform,
Docker, git and Node, and is already authenticated — no local install, and no
`gcloud auth application-default login`, because credentials come from the
metadata server.

```bash
git clone https://github.com/Merhawi12/FamilyGuard.git
cd FamilyGuard && git checkout restructure/three-apps-aws
./infrastructure/gcp/deploy.sh dev plan
```

Two things to know: the home directory persists but anything outside it is wiped
between sessions, and a session times out after about an hour idle. A long
`apply` is fine; walking away mid-apply is not, because an interrupted run can
leave state and reality out of step. Re-running `apply` reconciles it.

## Deploying

```bash
./deploy.sh dev plan
./deploy.sh dev apply
```

The project (`parentix-4be0d`) is recorded in `envs/<env>.tfvars`; set
`PROJECT_ID=...` only to override it. State goes to
`gs://parentix-4be0d-parentix-tfstate`, created on first run with versioning
on. Environments are Terraform workspaces, so `dev` and `prod` never
share state.

Then, from the repo root:

```bash
ENV_NAME=dev ./scripts/deploy-api.sh     # build → Artifact Registry → Cloud Run
ENV_NAME=dev ./scripts/deploy-web.sh     # build → GCS → CDN invalidation
```

## After the first apply

**1. Supply the external credentials.** Terraform creates the secret containers
with an empty placeholder so the service can boot. Add the real values:

```bash
printf 'sk_live_…'  | gcloud secrets versions add parentix-prod-stripe-secret-key --data-file=-
printf 'whsec_…'    | gcloud secrets versions add parentix-prod-stripe-webhook-secret --data-file=-
printf 'smtp.sendgrid.net' | gcloud secrets versions add parentix-prod-smtp-host --data-file=-
printf 'apikey'     | gcloud secrets versions add parentix-prod-smtp-user --data-file=-
printf 'SG.…'       | gcloud secrets versions add parentix-prod-smtp-pass --data-file=-
```

Cloud Run reads `latest`, so redeploy the API afterwards to pick them up.
Terraform keeps managing only version 1 and will not overwrite these.

**2. Point DNS at the load balancer.** `terraform output load_balancer_ip`, then
create an A record for each of the three hostnames. The managed certificate stays
in `PROVISIONING` until all three resolve — usually 15–60 minutes, occasionally
longer. Check with:

```bash
gcloud compute ssl-certificates describe parentix-prod-cert --global
```

**3. Create the first staff account.** The admin dashboard has no sign-up.

```bash
gcloud run jobs create parentix-prod-create-admin \
  --image <repo>/api:<tag> --region us-central1 \
  --set-cloudsql-instances "$(terraform output -raw sql_connection_name)" \
  --command node --args scripts/create-admin.js,--email,you@example.com
```

Simpler alternative: connect through the Cloud SQL Auth Proxy and run the script
locally against it.

**4. Register the Stripe webhook** at `terraform output stripe_webhook_url`.

## Email needs a decision

Google Cloud has no SES. The API speaks SMTP, which every option supports —
SendGrid, Mailgun, Postmark, Resend, or Google Workspace. Until `smtp-host` holds
a real value the API logs emails instead of sending them, which means **password
reset and email verification cannot complete**.

Compute Engine blocks outbound port 25 permanently; use 587 or 465.

## Costs

| | dev | prod |
|---|---|---|
| Cloud Run | ~$0 (scales to zero) | ~$15–40 |
| Cloud SQL | ~$9 (`db-f1-micro`, zonal) | ~$50 (`db-custom-1-3840`, regional) |
| Memorystore | — | ~$35 |
| VPC connector | — | ~$9 |
| Load balancer | — | ~$18 |
| Storage + CDN | ~$1 | ~$5 |
| **Total** | **~$10–15** | **~$130–160** |

Roughly half the AWS equivalent, mostly because Cloud Run scales to zero and
there are no NAT gateway charges.

The three biggest levers, in order: `redis_enabled` (also removes the VPC
connector), `db_availability_type`, and `api_min_instances`.

## Known trade-offs

**SPA deep links return HTTP 404.** A backend bucket serves `not_found_page`
with a 404 status, so `app.<domain>/dashboard` returns the right HTML with the
wrong status code. Browsers render it and routing works; crawlers see a 404.
Firebase Hosting handles rewrites properly and is the fix if this ever matters.

**Socket.IO relies on Cloud Run session affinity.** Serverless NEGs do not
support load-balancer session affinity, so `session_affinity = true` on the
service is what keeps a polling handshake on one instance. It is best-effort.
With `redis_enabled = true` the adapter covers cross-instance delivery, so the
failure mode is a reconnect rather than a lost message.

**`terraform destroy` will not drop a production database.**
`db_deletion_protection` is deliberate. Clear it explicitly when you mean it.
