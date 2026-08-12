# Production.
#
#   PROJECT_ID=<project> ./deploy.sh prod plan
#
# Set `domain` before the first apply. Changing it later replaces the managed
# certificate and the URL map, which means a window where the old hostnames stop
# resolving — cheap to get right up front, disruptive to change afterwards.

project_id = "parentix-4be0d"
env_name   = "prod"
region     = "us-central1"

domain          = "parentix.ca"
app_subdomain   = "app"
admin_subdomain = "admin"
api_subdomain   = "api"

# Set true only if you delegate the domain's nameservers to Cloud DNS. Leave
# false to keep DNS at your registrar and create three A records by hand.
#
# Stays false: the records live at GoDaddy (ns51/ns52.domaincontrol.com).
# Delegating now would create a Cloud DNS zone that answers nothing, because the
# domain's nameservers would still be GoDaddy's — and switching them means up to
# 48 hours of propagation to reach the state that already works.
#
# Since the web tier moved to Firebase Hosting the records point at two
# different places, and only one of them is ours:
#
#   @ www app admin   →  Firebase Hosting (addresses minted per connected
#                        domain in the console — see docs/DEPLOYMENT.md §1.5)
#   api               →  the load balancer, 34.149.73.107
#
# The load balancer address is written down here on purpose. It is a reserved
# global address that does not change, `terraform output load_balancer_ip` is
# the authority, and a DNS edit that drops the `api` record takes sign-in down
# everywhere with no clue left behind as to what it should be restored to.
manage_dns = false

# At least one warm instance: a cold start on a real user's login is a bad first
# impression, and a scaled-to-zero service drops every open websocket.
api_min_instances = 1
api_max_instances = 6
api_cpu           = "1"
api_memory        = "1Gi"

# 1 vCPU / 3.75 GB. db-f1-micro is a shared-core instance with no performance
# guarantee and is not suitable for production traffic.
#
# ENTERPRISE_PLUS would add a data cache and near-zero-downtime maintenance, but
# only accepts db-perf-optimized-N-* tiers, which start considerably higher.
db_edition = "ENTERPRISE"
db_tier    = "db-custom-1-3840"

db_disk_size_gb = 20
# Synchronous standby in a second zone. Roughly doubles the database cost and is
# the difference between a zone failure being a blip and being an outage.
db_availability_type     = "REGIONAL"
db_backup_retention_days = 14
db_deletion_protection   = true

# Required: more than one API instance means Socket.IO events have to cross
# instances. Adds roughly $35/month.
redis_enabled        = true
redis_memory_size_gb = 1

# Empty in steady state: app.parentix.ca leads CLIENT_URL on its own, and that
# entry is the one the API builds password-reset links and Stripe return URLs
# from.
#
# Pointed at the apex for one day on 2026-08-10, when app.parentix.ca had no DNS
# record at all and every emailed link went nowhere. The CNAME now exists and
# Firebase has issued a certificate for it — /, /login, /reset-password and
# /dashboard all answer 200 — so the canonical hostname is back in front.
client_link_origin = ""

# Sign in with Google. Not a secret — it ships inside the browser bundle and is
# sent to Google in the clear, which is why it lives here rather than in Secret
# Manager. It is still load-bearing: it is the audience an incoming Google ID
# token is checked against, so a wrong value refuses every sign-in rather than
# accepting one meant for another application.
#
# This is the project's Firebase-managed web client, not a client made for this
# app. The hand-made one (…bv1nd07…) sat here first and refused every sign-in
# with "invalid_client: no registered origin": its Authorised JavaScript origins
# list was empty, and the console would not commit an edit to it — the Save
# button stayed disabled. The Firebase client already carries every hostname
# that serves the Family App, because Firebase registers the custom domains
# attached to Hosting: app., the apex, www. and the *.web.app name. Each was
# checked from a browser at that origin, not assumed.
#
# What that borrowing costs: the origin list belongs to Firebase. Removing a
# domain from Firebase Auth's authorised domains would stop sign-in here, with
# nothing in this repo changing. Going back to a dedicated client is this one
# line, once that client's origins actually exist.
#
# The Android wrapper needs no client of its own — Capacitor serves the WebView
# from https://app.parentix.ca (see capacitor.config.json), which is on the
# list — but Google refuses OAuth inside embedded WebViews anyway, so the button
# is a browser and PWA feature. See docs/DEPLOYMENT.md.
#
# localhost:3000 is deliberately not covered: local builds leave
# VITE_GOOGLE_CLIENT_ID empty, which renders no button rather than a broken one.
google_client_id = "648085611770-iqb08gu4omr6nkk049bj2dsgrc3166jd.apps.googleusercontent.com"

email_from = "Parentix <no-reply@parentix.ca>"

# Where monitoring alerts go. Set this before the first production apply — an
# unmonitored production service is one where the first report of an outage
# comes from a customer. A role mailbox beats a personal one.
alert_email = "merhawigu@gmail.com"

labels = {
  cost-center = "production"
}

# ── Firebase Hosting ─────────────────────────────────────────────────────────
# The two Hosting sites serving the web apps. Created once with
#   firebase hosting:sites:create <id> --project parentix-4be0d
# and mapped to the `family` / `admin` deploy targets in .firebaserc.
#
# Recorded here because the API has to accept their permanent *.web.app origins,
# not only the custom domains: that address is how a release is verified before
# DNS is pointed at it, and afterwards it is the way in when the custom domain is
# the thing that is broken.
firebase_family_site = "parentix-4be0d"
firebase_admin_site  = "parentix-admin"

# Set to the outgoing certificate's name for one apply when the certificate's
# domain list changes, so api.parentix.ca keeps serving TLS while the
# replacement provisions. Empty in steady state — see variables.tf.
#
# Used once on 2026-08-10 and cleared the same day. The live certificate was
# named `parentix-prod-cert`, from before the domain list became part of the
# name, so renaming it to `parentix-prod-cert-0f27875d` forced a replacement —
# and the old one still covered app. and admin., two names that had already moved
# to Firebase Hosting and no longer resolved to this load balancer. Left alone
# that would eventually have blocked renewal for api. as well, since one
# unreachable name fails validation for every name on the certificate.
#
# The swap was staged through this variable so both certificates were attached
# while the replacement provisioned, and TLS on api.parentix.ca never dropped.
# The replacement reached ACTIVE in under ten minutes, because the name it covers
# already pointed here.
retained_ssl_certificate = ""
