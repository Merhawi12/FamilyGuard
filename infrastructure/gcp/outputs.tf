output "project_id" {
  value = var.project_id
}

output "region" {
  value = var.region
}

output "api_url" {
  description = "Public API base URL."
  value       = local.use_domain ? "https://${local.api_host}" : google_cloud_run_v2_service.api.uri
}

output "cloud_run_url" {
  description = "The service's own URL, always reachable and useful for debugging past the load balancer."
  value       = google_cloud_run_v2_service.api.uri
}

output "app_url" {
  description = "Family App, served by Firebase Hosting."
  value       = local.use_domain ? "https://${local.app_host}" : (var.firebase_family_site != "" ? "https://${var.firebase_family_site}.web.app" : "")
}

output "admin_url" {
  description = "Admin Dashboard, served by Firebase Hosting."
  value       = local.use_domain ? "https://${local.admin_host}" : (var.firebase_admin_site != "" ? "https://${var.firebase_admin_site}.web.app" : "")
}

output "firebase_family_site" {
  description = "Firebase Hosting site ID for the Family App — the `family` deploy target."
  value       = var.firebase_family_site
}

output "firebase_admin_site" {
  description = "Firebase Hosting site ID for the Admin Dashboard — the `admin` deploy target."
  value       = var.firebase_admin_site
}

output "cors_origins" {
  description = "Every browser origin the API is configured to accept. Useful for checking a hostname was not forgotten."
  value       = local.cors_origins
}

output "load_balancer_ip" {
  description = <<-EOT
    Point the API hostname's A record at this address. Only api.<domain> belongs
    here — the web hostnames are Firebase Hosting's and take its addresses, which
    the Firebase console prints when a custom domain is connected.

    Empty without a domain: no load balancer, no address.
  EOT
  value       = local.use_domain ? google_compute_global_address.lb[0].address : ""
}

output "ssl_certificate" {
  description = "Managed certificate currently attached to the HTTPS proxy. Pass to retained_ssl_certificate when its domain list changes."
  value       = local.use_domain ? google_compute_managed_ssl_certificate.main[0].name : ""
}

output "dns_name_servers" {
  description = "Copy into the registrar when manage_dns = true. Empty otherwise."
  value       = local.use_domain && var.manage_dns ? google_dns_managed_zone.main[0].name_servers : []
}

output "artifact_registry_repo" {
  description = "Docker repository the API image is pushed to."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.api.repository_id}"
}

output "cloud_run_service" {
  value = google_cloud_run_v2_service.api.name
}

output "sql_connection_name" {
  description = "Pass to `gcloud sql connect` or the Cloud SQL Auth Proxy."
  value       = google_sql_database_instance.main.connection_name
}

output "uploads_bucket" {
  value = google_storage_bucket.uploads.name
}

output "api_service_account" {
  description = "Also the FCM sender identity — push is authorised by this account's IAM role, not by a stored key."
  value       = google_service_account.api.email
}

output "scheduler_job" {
  description = "Run it now with `gcloud scheduler jobs run <this> --location <region>`. Its history, not the API's logs, is where a rejected run is recorded."
  value       = google_cloud_scheduler_job.safety_analysis.name
}

output "stripe_webhook_url" {
  description = "Register this endpoint in the Stripe dashboard."
  value       = local.use_domain ? "https://${local.api_host}/api/payments/webhook" : "${google_cloud_run_v2_service.api.uri}/api/payments/webhook"
}

output "google_client_id" {
  description = "OAuth Web client ID the Family App build is given, and the API accepts tokens for. Empty disables Google sign-in."
  value       = var.google_client_id
}
