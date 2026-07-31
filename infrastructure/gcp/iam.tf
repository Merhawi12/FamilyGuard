# One service account for the API, holding only the permissions it actually
# uses. Cloud Run's default compute service account is Editor on the whole
# project, which is far more than this needs.

resource "google_service_account" "api" {
  account_id   = "${local.prefix}-api"
  display_name = "Parentix API (${var.env_name})"

  depends_on = [google_project_service.services]
}

# Open connections through the Cloud SQL Auth Proxy.
resource "google_project_iam_member" "api_sql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.api.email}"
}

# Read the secrets mounted into the service. Granted per secret rather than
# project-wide, so this account cannot read anything added later by something
# else.
resource "google_secret_manager_secret_iam_member" "api_generated" {
  for_each = google_secret_manager_secret.generated

  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "api_supplied" {
  for_each = google_secret_manager_secret.supplied

  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

# Read, write and delete objects in the uploads bucket — and only that bucket.
resource "google_storage_bucket_iam_member" "api_uploads" {
  bucket = google_storage_bucket.uploads.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.api.email}"
}

# The one grant that is easy to miss and hard to diagnose.
#
# V4 signed URLs need a private key. Application Default Credentials on Cloud
# Run do not include one, so the storage client falls back to the IAM signBlob
# API — which requires this account to be able to impersonate *itself*. Without
# it, every upload request fails with a 403 whose message says nothing about
# signing.
resource "google_service_account_iam_member" "api_self_sign" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "api_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "api_metrics" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.api.email}"
}
