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
