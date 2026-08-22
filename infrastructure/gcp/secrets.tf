# Secret Manager — the Secrets Manager replacement.
#
# Two kinds of secret live here:
#
#   generated  JWT signing key, field-encryption key, database password.
#              Terraform creates the value; nobody ever needs to see it.
#   supplied   Stripe and SMTP credentials, which come from outside.
#              Terraform creates the container and one empty version so the
#              service can boot, and you add the real value as a new version:
#
#                printf 'sk_live_…' | gcloud secrets versions add \
#                  parentix-prod-stripe-secret-key --data-file=-
#
#              Cloud Run reads `latest`, so the new version takes effect on the
#              next revision. Terraform keeps managing only version 1 and will
#              not clobber what you added.

locals {
  # Secrets whose value comes from outside this config.
  supplied_secrets = [
    "stripe-secret-key",
    "stripe-webhook-secret",
    "stripe-premium-price-id",
    "stripe-family-price-id",
    "smtp-host",
    "smtp-user",
    "smtp-pass",
    # Outbound SMS for phone sign-in codes. Without these the API reports phone
    # sign-in as unavailable and the Family App hides the Phone tab, so the
    # whole identifier is inert until real values are added — which is what it
    # was, because these secrets did not exist and Cloud Run was never given
    # TWILIO_* at all.
    #
    # Supply the account SID and auth token, then *either* a sending number or a
    # Messaging Service SID; `isEnabled()` needs one of the two, not both.
    "twilio-account-sid",
    "twilio-auth-token",
    "twilio-from-number",
    "twilio-messaging-service-sid",
    # Web Push signing keys for parent browser notifications. Supplied rather
    # than generated because VAPID needs a P-256 keypair in raw base64url form,
    # which Terraform cannot produce; generate the pair once with
    # `node services/api/scripts/generate-vapid-keys.js` and add both as
    # versions. Replacing them invalidates every existing browser subscription,
    # so generate once and keep them.
    "vapid-public-key",
    "vapid-private-key",
    # The Cloud SQL instance's server certificate, so a TCP connection can
    # actually verify the server rather than merely encrypt to it. Not needed by
    # the socket topology this config deploys — it is here for a deployment that
    # reaches Postgres over private IP, where without it `rejectUnauthorized`
    # has to be off and TLS authenticates nothing. Supplying it turns
    # verification on by itself; see docs/SECURITY.md.
    #
    #   gcloud sql instances describe <instance> \
    #     --format='value(serverCaCert.cert)' \
    #     | gcloud secrets versions add parentix-<env>-db-ssl-ca --data-file=-
    "db-ssl-ca",
    # Read by scripts/deploy-web.sh and compiled into the Family App bundle.
    # Unlike the rest of this list it is not confidential — a Maps browser key
    # ships in public JavaScript by design and is protected by HTTP-referrer
    # restrictions, not secrecy. It lives here so a release picks it up
    # automatically instead of depending on whoever runs the deploy.
    "google-maps-key",
  ]
}

# ── Generated ────────────────────────────────────────────────────────────────

resource "random_password" "jwt_secret" {
  length  = 64
  special = false
}

# Exactly 32 bytes rendered as 64 hex characters, which is what the API
# validates on boot. Rotating this makes every already-encrypted row
# permanently unreadable, so it must stay stable for the life of the database —
# random_id holds its value in state and never regenerates on its own.
resource "random_id" "field_encryption_key" {
  byte_length = 32
}

resource "google_secret_manager_secret" "generated" {
  for_each = {
    "jwt-secret"           = random_password.jwt_secret.result
    "field-encryption-key" = random_id.field_encryption_key.hex
    "db-password"          = random_password.db.result
  }

  secret_id = "${local.prefix}-${each.key}"
  labels    = local.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_version" "generated" {
  for_each = {
    "jwt-secret"           = random_password.jwt_secret.result
    "field-encryption-key" = random_id.field_encryption_key.hex
    "db-password"          = random_password.db.result
  }

  secret      = google_secret_manager_secret.generated[each.key].id
  secret_data = each.value
}

# ── Supplied ─────────────────────────────────────────────────────────────────

resource "google_secret_manager_secret" "supplied" {
  for_each = toset(local.supplied_secrets)

  secret_id = "${local.prefix}-${each.value}"
  labels    = local.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.services]
}

# An empty placeholder so Cloud Run has a version to mount on the first deploy.
# The API treats an empty Stripe key or SMTP host as "not configured" and
# degrades rather than crashing.
resource "google_secret_manager_secret_version" "supplied_placeholder" {
  for_each = toset(local.supplied_secrets)

  secret      = google_secret_manager_secret.supplied[each.value].id
  secret_data = " "

  lifecycle {
    # Never re-create the placeholder: doing so would make it `latest` again and
    # silently blank out the real credential.
    ignore_changes = [secret_data]
  }
}
