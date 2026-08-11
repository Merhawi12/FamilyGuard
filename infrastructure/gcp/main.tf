locals {
  prefix = "parentix-${var.env_name}"

  labels = merge(
    {
      app         = "parentix"
      environment = var.env_name
      managed-by  = "terraform"
    },
    var.labels,
  )

  use_domain = var.domain != ""

  app_host   = local.use_domain ? "${var.app_subdomain}.${var.domain}" : ""
  admin_host = local.use_domain ? "${var.admin_subdomain}.${var.domain}" : ""
  api_host   = local.use_domain ? "${var.api_subdomain}.${var.domain}" : ""

  # ── Browser origins ────────────────────────────────────────────────────────
  #
  # One Firebase Hosting site answers on several names, and each is a separate
  # Origin header as far as a browser is concerned. The Family App site carries
  # the apex and www — that is where the marketing page lives — as well as
  # app.<domain>; the console carries admin.<domain> alone.
  #
  # The *.web.app names are included deliberately. They are permanent, they are
  # how a release is checked before DNS is pointed at it, and an API that has
  # never been told about them makes that check fail in a way that looks like a
  # broken build rather than a missing origin.
  firebase_default_origins = compact([
    var.firebase_family_site != "" ? "https://${var.firebase_family_site}.web.app" : "",
    var.firebase_family_site != "" ? "https://${var.firebase_family_site}.firebaseapp.com" : "",
    var.firebase_admin_site != "" ? "https://${var.firebase_admin_site}.web.app" : "",
    var.firebase_admin_site != "" ? "https://${var.firebase_admin_site}.firebaseapp.com" : "",
  ])

  # app.<domain> leads, because the API answers with this list's first entry
  # whenever it has to *build* a link rather than merely allow one — the
  # password-reset email and Stripe's return URL both do. In an environment with
  # no custom domain that job falls to the site's own web.app address, which is
  # the only name it has.
  #
  # `client_link_origin` overrides which name gets that job, for when the
  # canonical one is not yet usable. It is prepended and the list deduplicated,
  # so naming a hostname already present merely promotes it. See the variable:
  # the failure it exists to prevent is silent, because a dead origin still
  # allows CORS from every other name and only the emailed links are broken.
  client_origins = distinct(compact(concat(
    [var.client_link_origin],
    local.use_domain ? [
      "https://${local.app_host}",
      "https://${var.domain}",
      "https://www.${var.domain}",
      ] : [
      var.firebase_family_site != "" ? "https://${var.firebase_family_site}.web.app" : "",
    ],
  )))

  admin_origins = local.use_domain ? ["https://${local.admin_host}"] : compact([
    var.firebase_admin_site != "" ? "https://${var.firebase_admin_site}.web.app" : "",
  ])

  # The load balancer's certificate covers the API hostname and nothing else.
  certificate_domains = local.use_domain ? [local.api_host] : []

  # Everything the API will accept, deduplicated. Without a custom domain the
  # *.web.app names are the whole of it, which is what makes a domainless
  # environment usable rather than merely deployable.
  cors_origins = distinct(concat(
    local.client_origins,
    local.admin_origins,
    local.firebase_default_origins,
    var.extra_cors_origins,
  ))

  # Bootstrap image, deliberately not the real one.
  #
  # On a first apply the Artifact Registry repository is created by this same
  # run and is therefore empty, so pointing Cloud Run at <repo>/api:latest would
  # fail: the image does not exist yet. It cannot be pushed first either, since
  # scripts/deploy-api.sh reads the repository and service names from these
  # outputs. That is a deadlock, and it is broken with Google's public hello
  # container, which always exists.
  #
  # scripts/deploy-api.sh replaces it on the first release, and the
  # ignore_changes on the service's image means Terraform never drags it back.
  # Set var.api_image to pin a specific image instead.
  api_image = var.api_image != "" ? var.api_image : "us-docker.pkg.dev/cloudrun/container/hello"

  # A VPC connector is only needed to reach Memorystore: Cloud SQL is attached
  # through the Cloud Run socket integration, which does not use the VPC. No
  # Redis, no connector, no ~$9/month standing charge.
  need_vpc = var.redis_enabled
}

# Enabling an API is itself an API call, and everything below depends on these
# being on. Terraform cannot infer that ordering, so the dependency is explicit
# on each resource that needs it.
resource "google_project_service" "services" {
  for_each = toset([
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "compute.googleapis.com",
    "storage.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "redis.googleapis.com",
    "vpcaccess.googleapis.com",
    "dns.googleapis.com",
    "cloudbuild.googleapis.com",
    # Recurring jobs. See scheduler.tf.
    "cloudscheduler.googleapis.com",
    # The web tier. Enabling them here means a fresh project can run
    # `firebase deploy` without a detour through the console first.
    "firebase.googleapis.com",
    "firebasehosting.googleapis.com",
    # Push to the parents' Android app — the HTTP v1 send API. See iam.tf: the
    # API sends with its own service account, so enabling this and granting the
    # role is the whole of the server-side setup.
    #
    # fcmregistrations.googleapis.com is deliberately absent. It backs the
    # Firebase JS SDK's own token registration, which nothing here uses — the
    # Android app gets its token from Play Services through Capacitor.
    "fcm.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
  ])

  project = var.project_id
  service = each.value

  # Leave the APIs on when this config is destroyed. Disabling them would break
  # anything else in the project that happens to use them.
  disable_on_destroy         = false
  disable_dependent_services = false
}
