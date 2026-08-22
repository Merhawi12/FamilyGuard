# Parentix infrastructure on Google Cloud

Terraform for the whole platform. One configuration, one workspace per
environment.

```
            ┌─ parentix.ca / www / app.<domain> ─┐
Internet ─▶ ┤                                    ├─▶ Firebase Hosting  (not Terraform's)
            └─ admin.<domain> ──────────────────-┘

Internet ─▶ Global LB ── api.<domain> → Cloud Run ─┬─ Cloud SQL (Unix socket)
            (anycast)                              ├─ Memorystore (VPC, prod)
                                                   └─ Cloud Storage (uploads)
```

This configuration owns the right-hand half. The web apps are published to
Firebase Hosting by `scripts/deploy-web.sh` from `firebase.json` at the
repository root — Hosting is content, not infrastructure, and having two tools
own it is how a deployment ends up with two of it.

What is here because of that split: the load balancer has one backend, its
certificate covers `api.<domain>` alone, and `local.cors_origins` derives every
browser origin the API must accept. Cross-origin is the whole of the access
policy between the tiers, so a hostname missing from that list is a site that
loads and then fails every request.

## What replaced what

| AWS | Google Cloud |
|---|---|
| ECS Fargate | Cloud Run |
| RDS PostgreSQL | Cloud SQL for PostgreSQL |
| ElastiCache | Memorystore for Redis |
| S3 | Cloud Storage |
| CloudFront *(static)* | Firebase Hosting |
| ALB / CloudFront *(API)* | global external Application LB |
| ECR | Artifact Registry |
| Secrets Manager | Secret Manager |
| ACM | Google-managed SSL certificates |
| Route 53 | Cloud DNS *(optional)* |
| IAM roles | IAM service accounts |
| EventBridge Scheduler | Cloud Scheduler |
| CloudWatch | Cloud Logging + Cloud Monitoring |
| SNS *(mobile push)* | Firebase Cloud Messaging |
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

### `parentix-4be0d` is a Firebase project

That is fine — a Firebase project *is* a Google Cloud project, with Firebase
layered on top. Firebase Hosting is used deliberately (see below); nothing here touches
Firestore, Firebase Authentication, App Engine or the default `*.appspot.com` /
`*.firebasestorage.app` bucket, and
`disable_on_destroy = false` on the API enablement means a `terraform destroy`
cannot switch off an API that Firebase is relying on.

**But billing has to be on the Blaze plan.** A Firebase project on the free Spark
plan has no billing account attached, and Cloud Run, Cloud SQL, Memorystore and
Artifact Registry all refuse to be created without one. Check before you plan:

```bash
gcloud beta billing projects describe parentix-4be0d \
  --format='value(billingEnabled)'
```

`False` means every `apply` will fail on the first billable resource. Upgrade in
the Firebase console under **Settings → Usage and billing**. Blaze is
pay-as-you-go, not a flat fee, so an idle dev environment still costs about what
the table further down says — but set a budget alert, because nothing here caps
itself.

### Why Firebase Hosting serves the apps but not the API

Hosting is a very good static CDN: real SPA rewrites (no 404-on-deep-link
caveat), certificates it renews itself, atomic releases with one-click rollback,
and a free tier two bundles never leave.

It is a poor reverse proxy, and the API needs a good one. Hosting **does not
proxy a websocket upgrade**, so a `/api/**` rewrite would hold Socket.IO — which
carries alerts, chat and location for this product — on HTTP long-polling
forever. It also strips every cookie but `__session`, which is what Cloud Run's
session affinity uses to keep a polling handshake on one instance, and it adds a
proxy hop that Express is not configured for (`TRUST_PROXY=1`), so rate limiting
would start keying off an edge address.

So: static on Hosting, API on the load balancer, and the browser makes a genuine
cross-origin call. The price is one preflight per request shape and a build-time
`VITE_API_URL`. `docs/ARCHITECTURE.md` has the longer version.

### Or use Cloud Shell

[Cloud Shell](https://shell.cloud.google.com) has gcloud, Docker, git and Node,
and is already authenticated — no `gcloud auth application-default login`,
because credentials come from the metadata server.

**It does not have Terraform.** There is a command of that name, but it is a
placeholder that prints installation instructions and exits. Its suggested
`apt install` also does not survive the session: only `$HOME` persists. Install
the binary there instead, once:

```bash
TF=1.9.8
mkdir -p ~/bin
curl -fsSL "https://releases.hashicorp.com/terraform/${TF}/terraform_${TF}_linux_amd64.zip" -o /tmp/tf.zip
unzip -oq /tmp/tf.zip -d ~/bin && chmod +x ~/bin/terraform
grep -q 'HOME/bin' ~/.bashrc || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
export PATH="$HOME/bin:$PATH"
terraform version      # must print "Terraform v1.9.8", not install instructions
```

Then:

```bash
git clone https://github.com/Merhawi12/FamilyGuard.git
cd FamilyGuard && git checkout restructure/three-apps-aws
./infrastructure/gcp/deploy.sh dev plan
```

One more thing to know: a session times out after about an hour idle. A long
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
ENV_NAME=dev ./scripts/deploy-web.sh     # build → Firebase Hosting
```

`deploy-api.sh` is not optional after the first apply. The registry is created
by that apply and is therefore empty, so Cloud Run starts on Google's public
hello container — there is no API image to run yet. The first `deploy-api.sh`
replaces it; `ignore_changes` on the image keeps Terraform from reverting it.

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

**2. Point DNS at both front doors.** Two destinations, not one: `api` gets an A
record at `terraform output load_balancer_ip`; the apex, `www`, `app` and `admin`
get the addresses Firebase prints when each custom domain is connected in the
Firebase console. The load balancer's certificate covers `api.<domain>` alone and
stays in `PROVISIONING` until that name resolves — usually 15–60 minutes,
occasionally longer. Check with:

```bash
gcloud compute ssl-certificates list --global   --format='table(name,managed.status,managed.domainStatus)'
```

Firebase issues and renews its own certificates; there is nothing to wait on
beyond its console showing the domain as connected.

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

**5. Register the two Android apps for push.** The server side needs nothing:
`fcm.googleapis.com` is enabled by this config and the API sends with its own
service account, so there is no server key to store anywhere. What is needed is
the client side — an app registered in the Firebase project, and its
`google-services.json` in the build:

| App | Package | File goes in |
|---|---|---|
| Family (parent) | `ca.parentix.family` | `apps/family-app/android/app/` |
| Child | `com.parentix.child` | `apps/child-app/android/android/app/` |

Both Gradle projects apply the `google-services` plugin only when that file is
present, so a build without it succeeds and then cannot receive a single
notification. `scripts/build-apk.sh` warns when it is missing rather than letting
that be discovered on a handset. The child app additionally needs its FCM
credential uploaded to the Expo project (`eas credentials`), because its push
goes through Expo's relay. See docs/DEPLOYMENT.md §2.3a and §2.3b.

**6. Check the scheduled job ran.** Cloud Scheduler drives the hourly safety
analysis; the API's in-process timer is off on Cloud Run (`JOB_RUNNER=external`),
so if the job is broken nothing else picks the work up.

```bash
gcloud scheduler jobs describe parentix-prod-safety-analysis --location us-central1 \
  --format='value(status.code,lastAttemptTime)'
# Force one now rather than waiting for the hour:
gcloud scheduler jobs run parentix-prod-safety-analysis --location us-central1
```

A `401` in the job's history is an audience or service-account mismatch between
`scheduler.tf` and the `TASKS_AUDIENCE` the service was deployed with — it is
recorded on the Scheduler side, not in the API's logs.

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
| Firebase Hosting | $0 | $0–2 |
| Cloud Storage (uploads) | ~$1 | ~$3 |
| **Total** | **~$10–15** | **~$125–155** |

Roughly half the AWS equivalent, mostly because Cloud Run scales to zero and
there are no NAT gateway charges.

The three biggest levers, in order: `redis_enabled` (also removes the VPC
connector), `db_availability_type`, and `api_min_instances`.

## Known trade-offs

**The web tier is not in Terraform.** Firebase Hosting sites are created once
with the CLI and released from `firebase.json`. `terraform destroy` therefore
leaves the web apps serving, pointed at an API that no longer exists — tidy them
up separately. The upside is that a web release cannot be blocked by, or block,
an infrastructure change.

**A new web hostname needs two edits, not one.** DNS and the Firebase console
put it on the internet; `local.cors_origins` is what lets it call the API. Miss
the second and the site loads perfectly and fails every request — which reads
like an outage rather than a missing line of configuration. `terraform output
cors_origins` is the list the API actually has.

**Socket.IO relies on Cloud Run session affinity.** Serverless NEGs do not
support load-balancer session affinity, so `session_affinity = true` on the
service is what keeps a polling handshake on one instance. It is best-effort.
With `redis_enabled = true` the adapter covers cross-instance delivery, so the
failure mode is a reconnect rather than a lost message.

**`terraform destroy` will not drop a production database.**
`db_deletion_protection` is deliberate. Clear it explicitly when you mean it.
