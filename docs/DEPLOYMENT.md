# Deployment

Parentix runs on Google Cloud and Firebase Hosting, which is the same project
seen through two consoles:

| Tier | Runs on |
| --- | --- |
| Family App, Admin Dashboard | Firebase Hosting (two sites in `parentix-4be0d`) |
| API | Cloud Run, behind a global external HTTPS load balancer |
| Database | Cloud SQL for PostgreSQL |
| Uploads | Cloud Storage, private, signed URLs only |
| Realtime fan-out | Memorystore for Redis *(prod only)* |
| Secrets | Secret Manager |
| Push notifications | Web Push for browsers, Firebase Cloud Messaging for both Android apps |
| Recurring jobs | Cloud Scheduler |
| Logs, metrics, alerts | Cloud Logging and Cloud Monitoring |
| Mail | an external SMTP relay — Google Cloud has no SES |

The web tier and the API are separate origins, so the apps are built with
`VITE_API_URL=https://api.parentix.ca` and the API is configured to accept their
hostnames. `docs/ARCHITECTURE.md` explains why it is not one origin.

There is also a [single-VM alternative](../deploy/single-host/README.md) that
trades resilience for about a fifth of the cost.

## Prerequisites

| Tool | Why |
| --- | --- |
| `gcloud` | authentication, Cloud Run deploys, Secret Manager |
| `firebase` | publishing the web apps (`npm i -g firebase-tools`) |
| `terraform` ≥ 1.6 | infrastructure |
| `docker` | building the API image |
| `git` | image tags are commit SHAs |
| Node 20+ | building the web apps |

```bash
gcloud auth login
gcloud auth application-default login     # Terraform reads these separately
gcloud config set project parentix-4be0d

firebase login                            # separate credential store from gcloud
firebase projects:list                    # parentix-4be0d must appear
```

Billing must be enabled on the project. Terraform enables the APIs it needs
itself, which takes a few minutes on the first apply.

All commands take `ENV_NAME` (`dev` or `prod`) and default to `prod`.

### Before you deploy

Run the test suite against PostgreSQL, not just the default SQLite:

```bash
docker compose up -d postgres
npm --prefix services/api run test:pg   # TEST_DATABASE_URL=postgresql://…
```

The API migrates itself at boot, so a statement Postgres rejects does not
produce a failed test — it produces a Cloud Run revision that never becomes
healthy, while the previous one keeps serving and the deploy looks merely slow.
SQLite accepts several things Cloud SQL will not, and Postgres rejects them when
it parses the statement, so an empty table is no protection. This run is what
separates the two.

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
| Web apps | Firebase Hosting preview channels | the two live sites |
| Deletion protection | off | on |

Deploy `dev` first. It exercises the whole pipeline for roughly $10/month and
nothing in it is hard to delete.

### 1.2 Set the domain (prod)

Edit `prod.tfvars` before the first apply:

```hcl
domain = "parentix.ca"
```

Changing this later replaces the managed certificate, which means a window where
`api.<domain>` serves no HTTPS unless the replacement is staged through
`retained_ssl_certificate` (§1.5). It also invalidates every web bundle already
built, since `VITE_API_URL` is compiled in. Cheap to get right up front.

### 1.3 Deploy the infrastructure

```bash
./infrastructure/gcp/deploy.sh dev plan
./infrastructure/gcp/deploy.sh dev apply
```

The project (`parentix-4be0d`) comes from `envs/<env>.tfvars`, so it cannot
drift with whatever `gcloud config` happens to be set to. Override with
`PROJECT_ID=...` to target a scratch project.

State goes to `gs://parentix-4be0d-parentix-tfstate`, created on first run with
versioning enabled. Each environment is a Terraform workspace, so `dev` and
`prod` never share state.

### 1.4 Create the Firebase Hosting sites

Two sites, one per app, both in `parentix-4be0d`. Created once, with the CLI —
Terraform does not manage them, and their IDs are recorded in the tfvars only so
the API can be told to accept their origins.

```bash
firebase hosting:sites:create parentix-admin --project parentix-4be0d
firebase hosting:sites:list --project parentix-4be0d
```

The default site (`parentix-4be0d`) serves the Family App; `parentix-admin`
serves the console. `.firebaserc` maps them to the `family` and `admin` deploy
targets, and `firebase.json` holds the rewrites, cache policy and security
headers for each.

Both keep a permanent `https://<site>.web.app` address. That is how a release is
checked before any DNS points at it, and it stays the way in when the custom
domain is what is broken — which is why both are in the API's CORS allowlist and
not only the custom hostnames.

### 1.5 Point DNS at the two front doors

`parentix.ca` is registered with GoDaddy and its nameservers stay there —
`manage_dns = false`, so Terraform creates no zone and you add the records by
hand.

There are now **two** destinations, not one. The web hostnames belong to Firebase
Hosting and the API hostname to the load balancer:

| Type | Name | Value | Serves |
| --- | --- | --- | --- |
| A | `@` | *(Firebase, both addresses)* | marketing site |
| A | `www` | *(Firebase, both addresses)* | marketing site |
| A | `app` | *(Firebase, both addresses)* | Family App |
| A | `admin` | *(Firebase, both addresses)* | Admin Dashboard |
| A | `api` | *(load balancer IP)* | Cloud Run |

Firebase mints its pair of addresses when you connect each domain, so take them
from the console rather than from here:

**Firebase console → Hosting → the site → Add custom domain.** Add
`parentix.ca`, `www.parentix.ca` and `app.parentix.ca` to the family site and
`admin.parentix.ca` to the admin site. Each one prints a TXT record to prove
ownership and then two A records to serve from. Firebase issues and renews the
certificates itself; there is nothing to provision by hand.

> **Delete everything on `@` that Firebase did not mint.** Two different sets of
> records have pointed the apex somewhere else: GoDaddy's domain forwarding
> addresses, and the load balancer, from when it served the web tier as well as
> the API. Both survive the move to Firebase Hosting, because nothing removes
> them — connecting the domain adds a record, it does not clean up after the
> previous occupant. A browser picks between a host's addresses at random, so
> the apex then answers with a different site, or a certificate error, depending
> on the roll: an intermittent fault for a share of visitors that will not
> reproduce for whoever reports it. The load balancer's certificate covers
> `api.<domain>` and nothing else, so on the apex it can only ever fail.

The API's address comes from Terraform and does not change:

```bash
terraform -chdir=infrastructure/gcp output -raw load_balancer_ip
```

Confirm before moving on:

```bash
npm run check:dns          # ENV_NAME=dev npm run check:dns for another environment
```

That resolves every hostname and then makes each address prove what it is — the
web names must serve HTML under a certificate valid for the name asked for, and
`api.<domain>` must answer `/api/health`. Addresses alone are not enough to
check: a leftover record resolves perfectly and still answers with the wrong
site. It needs only curl and python, so it runs from a laptop during an incident
rather than only from Cloud Shell.

The load balancer's managed certificate covers `api.parentix.ca` only, and stays
in `PROVISIONING` until that name resolves to it:

```bash
gcloud compute ssl-certificates list --global \
  --format='table(name,managed.status,managed.domainStatus)'
```

Nothing works over HTTPS until it reads `ACTIVE`. If the hostname is stuck at
`FAILED_NOT_VISIBLE`, its A record is wrong or has not propagated — fix it and
wait; the certificate retries on its own.

> **Changing the certificate's domain list needs two applies.** A managed
> certificate sits in `PROVISIONING` for anywhere from fifteen minutes to
> several hours, and a proxy holding only that certificate serves no HTTPS in the
> meantime. So set `retained_ssl_certificate` to the outgoing certificate's name
> (`terraform output -raw ssl_certificate` before you change anything), apply,
> wait for the new one to read `ACTIVE`, then clear the variable and apply again.
> Both are attached in between and the proxy picks whichever matches the SNI.
> §6 walks through this for the move off the load-balancer-hosted web tier.

### 1.6 Mail authentication records

Also at GoDaddy, and easy to forget until password-reset emails start landing in
spam. Sending as `support@parentix.ca` through a third-party relay means the
domain has to authorise that relay:

`parentix.ca` runs on Google Workspace, so all four records are Google's:

| Type | Name | Value |
| --- | --- | --- |
| MX | `@` | `aspmx.l.google.com` (1), `alt1`/`alt2` (5), `alt3`/`alt4` (10) |
| TXT | `@` | `v=spf1 include:_spf.google.com ~all` |
| TXT | `google._domainkey` | the 2048-bit key from the Admin console |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; …` |

Publishing the DKIM record is only half of turning DKIM on — **Admin console →
Apps → Google Workspace → Gmail → Authenticate email → Start authentication**
is the switch, and until it is thrown Google publishes a key it does not sign
with.

That matters more here than it usually would, because DMARC is already at
`p=quarantine` rather than `p=none`. Enforcing before both mechanisms pass means
delivery rests on SPF alignment alone, and SPF breaks on any forwarding hop — a
parent whose work address forwards home, a school alias. The message is then
quarantined rather than bounced, so nobody is told, and the symptom is a reset
code that "never arrived" for one parent and works for everyone else.

`npm run check:dns` asserts all four, and fails specifically on the enforcing-
without-DKIM combination.

> If GoDaddy also hosts mailboxes on `parentix.ca` (Microsoft 365 is the usual
> bundle), do **not** replace the existing SPF record — a domain may have only
> one, and a second breaks both. Merge the relay's `include:` into the record
> that is already there.

### 1.7 Supply the external credentials

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

Push notifications to a parent's browser need a VAPID keypair. Generate it once
and add both halves:

```bash
node services/api/scripts/generate-vapid-keys.js

printf 'BM…'  | gcloud secrets versions add parentix-$ENV-vapid-public-key --data-file=-
printf 'k1…'  | gcloud secrets versions add parentix-$ENV-vapid-private-key --data-file=-
```

> **Generate the VAPID pair once and keep it.** Browsers subscribe against the
> public key, so replacing it invalidates every existing subscription — every
> parent silently stops receiving notifications until they turn them on again.
> Until both values are set, `GET /api/notifications/push/config` reports
> `available: false` and the Settings screen says push is unavailable rather
> than failing when a parent tries to subscribe.

Phone sign-in needs an SMS provider. Supply the account SID and auth token, then
**either** a sending number **or** a Messaging Service SID — one of the two, not
both:

```bash
printf 'AC…'          | gcloud secrets versions add parentix-$ENV-twilio-account-sid --data-file=-
printf '…'            | gcloud secrets versions add parentix-$ENV-twilio-auth-token --data-file=-
printf '+15550000000' | gcloud secrets versions add parentix-$ENV-twilio-from-number --data-file=-
# …or a messaging service instead of a single number:
printf 'MG…'          | gcloud secrets versions add parentix-$ENV-twilio-messaging-service-sid --data-file=-
```

> **Until these hold real values, phone sign-in is switched off, not broken.**
> `GET /api/auth/providers` reports `phone: false` and the Family App hides the
> Phone tab entirely, because a code that cannot be sent is a sign-in that cannot
> be finished. Registering or signing in by phone is simply unavailable — the
> other identifiers are unaffected.
>
> This is the one credential whose absence is invisible from the outside: there
> is no error, just a missing tab. Confirm it took effect:
>
> ```bash
> curl -s https://api.parentix.ca/api/auth/providers
> # {"password":true,"google":true,"phone":true}
> ```
>
> A Twilio trial account will only text numbers you have verified in its console,
> which fails exactly like bad credentials from the outside — the API logs the
> provider's own error code, and that is what separates the two.

Cloud Run reads `latest`, so redeploy the API afterwards. Terraform keeps
managing only version 1 and will not overwrite these.

`JWT_SECRET`, `FIELD_ENCRYPTION_KEY` and the database password are generated by
Terraform — you never need to see them.

> **Email needs a decision, and nothing works until it is made.** Google Cloud
> has no SES. Until `smtp-host` holds a real value the API logs emails instead of
> sending them, which means **password reset and email verification cannot
> complete** — the endpoints answer normally and no mail arrives. Any relay
> works: SendGrid, Mailgun, Postmark, Resend, Google Workspace. Compute Engine
> blocks outbound port 25 — use 587.
>
> Confirm it took effect, because a wrong value fails exactly like no value:
>
> ```bash
> gcloud run services logs read parentix-prod-api --region us-central1 --limit 20 >   | grep -i mail
> ```
>
> Or check it directly, which separates "no relay" from "wrong credentials" —
> the two states the send path collapses into one silent failure:
>
> ```bash
> npm --prefix services/api run check:mail                       # config + connect
> npm --prefix services/api run check:mail -- --to you@example.com   # …and send one
> ```
>
> The API also states this at boot — `mail: smtp smtp.sendgrid.net`, or
> `mail: DISABLED — password reset and email verification cannot complete` — and
> logs an error on every production start without a relay. The admin console's
> Overview reports the same thing under Delivery channels.

#### Google (Gmail or Workspace) as the relay

One command does the whole of it — test the credential, write the local `.env`,
store the three secrets, roll the revision that picks them up, then verify what
was stored rather than what was typed:

```bash
npm run mail:setup -- support@parentix.ca --to you@example.com --deploy
```

It reads the app password from stdin, never from `argv`, and refuses to store
anything Gmail has not already accepted. Before running it, in the Google
account that will send:

1. **Turn on 2-Step Verification.** App passwords do not exist without it — the
   `myaccount.google.com/apppasswords` page simply does not resolve, which reads
   as "Google removed the feature" rather than "you have not enabled the thing it
   depends on".
2. **Create the app password** and paste it with the spaces removed. Google
   displays 16 characters as four groups of four; Gmail's SMTP AUTH rejects the
   spaced form with the same `535` it gives a revoked password. The script strips
   them, and refuses anything that is not 16 characters once stripped.
3. Nothing else. IMAP and POP are receiving settings and irrelevant here, and
   "less secure app access" was removed in 2022 — app passwords replaced it.

#### The mailboxes the product promises

Three addresses on `parentix.ca` are printed in front of users, and each has to
exist before the page that names it is true. `support@` is a Workspace **user**
— you sign in as it to generate the app password, which an alias cannot do. The
other two are aliases on that same mailbox and cost nothing:

| Address | Promised by | Kind |
| --- | --- | --- |
| `support@parentix.ca` | `EMAIL_FROM`, and the contact-form `Reply-To` | user |
| `legal@parentix.ca` | [Terms.jsx](../apps/family-app/src/pages/Terms.jsx) | alias |
| `privacy@parentix.ca` | [PrivacyPolicy.jsx](../apps/family-app/src/pages/PrivacyPolicy.jsx) | alias |

The last two are commitments in published legal text, which is the reason to
create them in the same sitting rather than when someone first writes in: a
privacy request that bounces is a compliance problem, not a support backlog.

> **`EMAIL_FROM` must be the authenticating account.** Gmail rewrites the `From`
> header to the account that signed in unless the address is a verified alias,
> so authenticate as `support@parentix.ca` itself rather than sending as it from
> somewhere else. A free `@gmail.com` account with the address pasted into
> `EMAIL_FROM` does not work: the header is rewritten, the parent sees the gmail
> address, and the message carries an `X-Google-Original-From` header
> advertising the mismatch.
>
> With DMARC at `p=quarantine` that shortcut is worse than cosmetic. Mail sent
> from a `gmail.com` account is signed `d=gmail.com` and envelope-sent from
> `gmail.com`, so neither DKIM nor SPF *aligns* with a `parentix.ca` header
> From — DMARC fails, and the policy says quarantine. Reset codes go to spam for
> the recipients strict enough to honour it, and nothing on this side logs a
> problem.

> **Do not use `smtp-relay.gmail.com` with IP allowlisting.** It fails the way
> Brevo did: there is no Cloud NAT in this project and Cloud Run egress is
> `PRIVATE_RANGES_ONLY`, so SMTP leaves over Google's shared dynamic pool and
> there is no stable address to allowlist. If you use the relay, configure it
> for *Require SMTP Authentication* only. `smtp.gmail.com` with an app password
> has no such requirement, which is why it is what the script configures.

Google caps a free account at **500 recipients a day** and Workspace at
**2,000**. Past the cap every send fails for 24 hours — which here means
password reset and signup verification stop, silently, from the outside. That
ceiling is the reason to treat Gmail as the way to get delivery working today
rather than the permanent answer for a consumer product.

### 1.8 Create the first staff account

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

### 1.9 Set up Sign in with Google *(optional)*

The Family App offers "Sign in with Google" only when an OAuth client is
configured. Without one the button is not rendered and `POST /api/auth/google`
answers 503 — the feature is absent, not broken.

**Google Cloud console → APIs & Services → Credentials → Create OAuth client ID
→ Web application.** Authorised JavaScript origins must list every hostname that
serves the app, or Google refuses to issue a token to it:

```
https://parentix.ca
https://www.parentix.ca
https://app.parentix.ca
https://parentix-4be0d.web.app
http://localhost:3000          # local development
```

No redirect URIs are needed: this uses Google Identity Services, which returns
the ID token to the page rather than through a redirect.

Put the ID in `prod.tfvars` and apply. One value feeds both sides — the API is
told which audience to accept and `deploy-web.sh` reads the same value back out
of the Terraform output to compile into the bundle, so the button and the
endpoint cannot end up configured against different clients:

```hcl
google_client_id = "1234567890-abc.apps.googleusercontent.com"
```

It is **not a secret** and deliberately not in Secret Manager: it ships inside
the browser bundle and travels to Google in the clear. What makes the flow safe
is that the ID token coming back is signed by Google and its `aud` claim is
checked against this value — which is exactly why an empty value disables the
feature rather than accepting any audience.

> **The packaged Android app needs a second client.** Google refuses OAuth in an
> embedded WebView, so the button in the APK cannot use the web flow. That needs
> an **Android** OAuth client, created against the app's package name
> (`ca.parentix.family`) and the SHA-1 of its signing key, plus a native plugin
> to drive it. Its client ID then goes in `google_extra_client_ids`, because its
> tokens carry a different `aud`. Until that is done the button simply does not
> appear in the app, and email-and-password sign-in works there as normal.
>
> ```bash
> keytool -list -v -keystore apps/child-app/android/android/app/debug.keystore >   -alias androiddebugkey -storepass android | grep SHA1
> ```

### 1.10 Point Stripe at the webhook

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

If the push fails with `dial tcp …: connect: connection refused`, that is the
local network giving out partway through a few hundred megabytes — common in
Cloud Shell. Re-running resumes from the layers that made it. If it keeps
failing, build server-side instead, which uploads only the build context:

```bash
USE_CLOUD_BUILD=1 ENV_NAME=prod ./scripts/deploy-api.sh
```

That path needs no Docker daemon at all.

**The first apply leaves Cloud Run on a placeholder.** Terraform creates the
Artifact Registry repository in the same run, so it is empty and there is no API
image to point at yet — the service boots Google's public hello container
instead. This first `deploy-api.sh` is what replaces it, and Terraform ignores
the image afterwards. Until then `/api/health` will not answer, which is
expected rather than a fault.

### 2.2 Web apps

```bash
ENV_NAME=prod ./scripts/deploy-web.sh                    # both
ENV_NAME=prod ./scripts/deploy-web.sh family             # one
ENV_NAME=prod CHANNEL=rc ./scripts/deploy-web.sh         # a preview URL, live site untouched
```

Builds both apps and publishes them to Firebase Hosting. `VITE_API_URL` and
`VITE_ADMIN_URL` come from the Terraform outputs and the Google Maps browser key
from Secret Manager, so a release does not depend on what the person running it
happens to have exported.

Hosting applies `firebase.json`: hashed assets get a one-year immutable cache,
every HTML response `max-age=0, must-revalidate` — otherwise a browser keeps
loading the previous build's script tags — plus the security headers and the SPA
rewrites. A release is atomic and versioned, so a rollback is a console click
rather than a rebuild.

The script refuses to publish a Family App bundle that still contains
`index.html`: Hosting would answer `/` with it and the marketing page would never
be reached. See `docs/ARCHITECTURE.md`.

A preview channel gets a throwaway URL of its own and expires after seven days.
That URL is not in the API's CORS allowlist — it cannot be, it is minted per
deploy — so add it to `extra_cors_origins` for as long as you need it, or the
preview will load and then fail every request.

> **CI can do this instead.** `.github/workflows/deploy-web.yml` runs the same
> publish on a push to `main` once `FIREBASE_SERVICE_ACCOUNT` and the `API_URL` /
> `ADMIN_URL` repository variables are set. Without them it skips rather than
> fails.

### 2.3 Android apps

```bash
npm run apk:child      # the monitored device agent
npm run apk:family     # the parent app
```

Both produce a release APK under
`apps/<app>/android/app/build/outputs/apk/release/`. Neither is built by
`npm run build`, which only makes the two web bundles — an Android release is a
separate, explicit step because it needs the SDK, takes minutes, and old
versions stay installed on real devices long after a web deploy has moved on.

The API hostname is compiled into both, so **a new API hostname means new builds
and a new Play release**. Installed copies never pick it up.

> **They are signed with the DEBUG key until a keystore exists.** That APK
> installs fine for testing and Google Play rejects it outright. Generate a real
> one once, with `apps/child-app/android/android/generate-release-keystore.sh`, and back
> it up somewhere you will still have in three years: losing it means the listing
> can never be updated again.

**The Family App is a web app in a Capacitor shell.** `apps/family-app/android`
is generated by `npx cap add android` and committed, because it holds the signing
and manifest configuration. Two things differ from the hosted build, both because
there is no marketing site inside an app:

- The SPA shell keeps the name `index.html`. Capacitor's WebView loads that file
  from the bundled assets and has no rewrite layer, so the rename that keeps the
  marketing page at `/` on Firebase Hosting would leave the app with no entry
  point. `VITE_BUILD_TARGET=capacitor` turns the rename off.
- `/` renders the app rather than redirecting to `landing.html`, which is not
  shipped. See `__NATIVE__` in `apps/family-app/src/App.jsx`.

`capacitor.config.json` sets `server.hostname` to `app.parentix.ca`. That is not
cosmetic: it makes the WebView's origin `https://app.parentix.ca`, a hostname the
API already accepts, so the app needs no CORS entry of its own and its
`localStorage` is namespaced to the real origin rather than to `localhost`.

### 2.3a Child app notes



```bash
cd apps/child-app/android
EXPO_PUBLIC_API_URL=https://api.parentix.ca/api npx expo run:android --variant release
```

Values are inlined at build time, so a new API hostname means a new build and a
new Play release.

> **Never run `expo prebuild` in `apps/child-app/android`.** Its `android/`
> subdirectory is committed source, not generated output: it holds the
> accessibility service, the VPN service, the usage-stats and app-blocker
> modules, the DNS web-history reporter, and manifest entries that no config
> plugin produces. `prebuild` deletes the directory and regenerates it from the
> Expo config, which silently drops every one of those — the app still compiles,
> and then blocks nothing, monitors nothing and reports nothing. That project
> deliberately ships no `prebuild` script; the iOS one does, where there is
> nothing to lose.
>
> Native dependencies are picked up by `useExpoModules()` autolinking in
> `android/settings.gradle`, so adding an Expo package needs no regeneration.
> Anything a config plugin would have written — a permission, a service, a
> meta-data entry — is applied to `android/app/src/main/AndroidManifest.xml` by
> hand. `app.config.js`'s `plugins` and `android.permissions` are documentation
> here; the manifest is what ships.
>
> Push to the child device also needs FCM: register `com.parentix.child` in the
> Firebase project, download `google-services.json` into
> `apps/child-app/android/android/app/`, and upload the FCM credential to the Expo
> project (`eas credentials`). Expo's relay hands off to FCM for Android
> delivery, so both halves are required.
>
> `android/app/build.gradle` applies the `google-services` plugin only when that
> file is present, so a build without it succeeds — and then
> `getExpoPushTokenAsync()` throws "Default FirebaseApp is not initialized" at
> runtime, which `push.js` catches and records as a warning nobody reads.
> `npm run apk:child` prints a warning when the file is absent for exactly that
> reason. Everything other than notifications works either way.

### 2.3b Family app notes

The parent app ships twice from one codebase: as a web app on Firebase Hosting,
and as an Android app wrapped by Capacitor. `npm run apk:family` builds the
second, running `vite build` with `VITE_BUILD_TARGET=capacitor` and then
`npx cap sync android`.

**Notifications need FCM here too, and for a reason specific to the wrapper.**
Capacitor renders the app in an Android WebView, and WebView does not implement
the Push API — `PushManager` is simply absent — so the Web Push transport that
serves every browser cannot be used at all. `src/services/push.js` detects the
native platform and registers an FCM token through
`@capacitor/push-notifications` instead; the API stores it as platform `fcm` and
sends through FCM HTTP v1.

Register `ca.parentix.family` in the Firebase project and download
`google-services.json` into `apps/family-app/android/app/`. Capacitor's generated
`app/build.gradle` already applies the `google-services` plugin conditionally, so
as with the child app a missing file builds cleanly and delivers nothing;
`npm run apk:family` warns.

Nothing is needed on the server: the API authenticates to FCM with its own Cloud
Run service account (`roles/firebasecloudmessaging.admin`, granted in `iam.tf`), so
there is no server key and no secret to add.

To confirm the whole chain on a device: sign in, open Settings → Notifications,
turn the toggle on, then **Send a test notification**. The device should appear
in "Where you get notifications" labelled `Parentix app on <model>`.

### 2.4 Order that matters

1. **Infrastructure** before anything that reads a Terraform output.
2. **API** before web, when a release adds an endpoint the front end calls.
3. **Web** before API, when a release removes one.
4. **Child app** last, and remember old versions stay installed on real devices —
   the API must keep accepting them.

### 2.5 Before you release

```bash
npm run test:all
```

That is lint, both web builds, the API suite, both end-to-end harnesses, and the
Chromium run over the two web apps. Add the PostgreSQL pass (§1) as well — the
SQLite suites cannot tell you whether Cloud SQL will accept the same SQL.

---

## 3. Verifying a release

```bash
TF="terraform -chdir=infrastructure/gcp"
API=$($TF output -raw api_url)
APP=$($TF output -raw app_url)
ADMIN=$($TF output -raw admin_url)

curl -fsS "$API/api/health"

# The web tier: `/` must be the marketing page, a deep link must be a 200, and
# a hashed asset must be immutable.
curl -fsS "$APP/" | grep -q '<title>Parentix — Calm' && echo "apex serves the marketing page"
curl -fsS -o /dev/null -w 'deep link %{http_code}\n' "$APP/dashboard/children"
curl -fsS -o /dev/null -w 'console  %{http_code}\n'  "$ADMIN/users"

# Cross-origin is the whole of the access policy now, so check it directly:
# every app origin must come back, and nothing else may.
for o in "$APP" "$ADMIN" "https://parentix.ca" "https://not-us.example"; do
  printf '%-32s ' "$o"
  curl -sS -o /dev/null -D - -H "Origin: $o" "$API/api/health" \
    | grep -i '^access-control-allow-origin' || echo '(refused)'
done
```

The last block is the one that catches the mistake this architecture makes
possible: a hostname added to DNS and to Firebase but never added to
`CORS_ORIGINS`. The site loads perfectly and then every request fails, which
reads like an outage rather than a missing line of configuration.

Then, in a browser: sign in as a parent, open a page that uses realtime (the
socket should connect, not fall back to polling forever), sign in to the admin
console, and confirm a password-reset email actually arrives.

Two things have no request to curl and are therefore easy to ship broken:

```bash
# The hourly job. Cloud Run's in-process timer is off (JOB_RUNNER=external), so
# a failing Scheduler job means the pass simply does not happen — silently.
gcloud scheduler jobs run parentix-prod-safety-analysis --location us-central1
gcloud scheduler jobs describe parentix-prod-safety-analysis --location us-central1 \
  --format='value(status.code,lastAttemptTime)'   # empty status.code = success

# Push. Settings → Notifications → Send a test notification, in each client that
# matters: a desktop browser, and the Android app if it has been installed.
gcloud run services logs read parentix-prod-api --region us-central1 --limit 50 \
  | grep 'push dispatched'
```

```bash
gcloud run services logs read parentix-prod-api --region us-central1 --limit 50
firebase hosting:versions:list --site parentix-4be0d --project parentix-4be0d
```

---

## 4. Rolling back

```bash
# API — redeploy a previous image tag (tags are commit SHAs)
IMAGE_TAG=<old-sha> ENV_NAME=prod ./scripts/deploy-api.sh

# or shift traffic to the previous revision without a rebuild
gcloud run services update-traffic parentix-prod-api \
  --region us-central1 --to-revisions <revision>=100

# Web — Hosting keeps every release, so no rebuild is needed
firebase hosting:versions:list --site parentix-4be0d --project parentix-4be0d
#   then: Firebase console → Hosting → the site → ⋮ on the previous release →
#   "Roll back". It is atomic and takes effect immediately.

# Or rebuild from the previous commit, if the release you want is not retained
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
| Firebase Hosting | $0 | $0–2 |
| Cloud Storage (uploads) | ~$1 | ~$3 |
| **Total** | **~$10–15** | **~$125–155** |

Firebase Hosting's free tier is 10 GB stored and 360 MB/day transferred, which
two bundles of a few hundred kilobytes do not come close to. It replaced roughly
$5/month of bucket storage and Cloud CDN egress, and it takes the CDN, the
certificates and the release history with it.

The three biggest levers, in order:

1. `redis_enabled = false` — also removes the VPC connector, so about $44.
2. `db_availability_type = "ZONAL"` — roughly halves the database cost.
3. `api_min_instances = 0` — free when idle, at the price of a cold start.

The load balancer's ~$18 now buys one hostname. A Cloud Run domain mapping would
serve `api.parentix.ca` for nothing, but gives up Cloud Armor, request logging at
the edge and a stable anycast address — worth revisiting if cost matters more
than those.

Set a budget alert; none of this caps itself.

---

## 6. Moving the web tier onto Firebase Hosting

The one-off migration from the previous arrangement, where the load balancer
served both apps out of Cloud Storage buckets. Written as a runbook because the
order is what keeps the site up: **publish, then point DNS, then take the old
path away.** Doing it in any other order means an outage.

**Before you start**, know the two facts that make this safe:

- `app.parentix.ca` and `admin.parentix.ca` are already in the API's CORS
  allowlist, so the moment Firebase serves those names, sign-in works with no
  API change at all.
- `parentix.ca`, `www.parentix.ca` and both `*.web.app` names are **not**. They
  need step 3 before anything on them can call the API.

### 6.1 Publish to Firebase, changing nothing else

```bash
ENV_NAME=prod ./scripts/deploy-web.sh
```

No DNS points at these sites yet, so the live site is untouched. Check the
release at `https://parentix-4be0d.web.app` and `https://parentix-admin.web.app`:
the marketing page at `/`, a deep link returning 200, the console's sign-in
screen. API calls will fail here until step 3 — that is expected, not a fault.

### 6.2 Teach the API the new origins

`local.cors_origins` already derives them; this is the apply that delivers them.

```bash
./infrastructure/gcp/deploy.sh prod plan     # read it: the web buckets are destroyed here
```

The plan removes `google_storage_bucket.family_app`, `admin_app`, both backend
buckets and the URL map's host rules, and replaces the certificate. **Do not
apply it yet** — those buckets are still serving production. Apply only the
Cloud Run change for now:

```bash
./infrastructure/gcp/deploy.sh prod apply -target=google_cloud_run_v2_service.api
```

Confirm, before touching DNS:

```bash
for o in https://parentix.ca https://www.parentix.ca https://parentix-4be0d.web.app; do
  printf '%-34s ' "$o"
  curl -sS -o /dev/null -D - -H "Origin: $o" https://api.parentix.ca/api/health \
    | grep -i '^access-control-allow-origin' || echo '(refused — stop here)'
done
```

Now sign in for real at `https://parentix-4be0d.web.app`. Everything the release
does should work from there before any customer sees it.

### 6.3 Connect the custom domains and move DNS

Follow §1.5. Do `admin.parentix.ca` first — it has the fewest users and the
loudest testers — then `app.parentix.ca`, then the apex and `www`.

Each hostname keeps working from the old bucket until its A record changes, so
this is one name at a time with a check in between, not a big bang. Lower the
TTL to 600 a day beforehand if you want a fast retreat.

### 6.4 Retire the load balancer's web tier

Only once every hostname resolves to Firebase and has been used in anger.

```bash
# Stage the certificate change so api.parentix.ca keeps serving TLS throughout
terraform -chdir=infrastructure/gcp output -raw ssl_certificate    # → parentix-prod-cert
```

Put that name in `retained_ssl_certificate` in `prod.tfvars`, then:

```bash
./infrastructure/gcp/deploy.sh prod apply
```

This destroys the two web buckets, their backend services and the URL map's host
rules, and creates the API-only certificate alongside the old one. Wait for it:

```bash
watch -n 60 "gcloud compute ssl-certificates list --global \
  --format='table(name,managed.status)'"
```

When the new certificate reads `ACTIVE`, clear `retained_ssl_certificate` and
apply once more. The old certificate is detached and deleted, and
`api.parentix.ca` never stopped serving.

### 6.5 What to check afterwards

- `https://parentix.ca/` is the marketing page, on the first try and every try
  — the GoDaddy forwarding records on `@` are the thing that breaks this.
- A deep link such as `https://app.parentix.ca/dashboard/children` returns 200,
  not 404. That was a standing defect of the bucket arrangement.
- The socket connects rather than polling forever.
- A password-reset email carries a 6-digit code, and entering it on
  `https://app.parentix.ca/login` reaches the "choose a new password" step.
  There is no link in that message any more; `/reset-password` is a redirect
  kept only for bookmarks.
- Stripe returns to the dashboard after a checkout.
- The child app still reports in. It talks to `api.parentix.ca` and should be
  entirely unaffected — confirm rather than assume, because a device that stops
  reporting is silent by nature.
