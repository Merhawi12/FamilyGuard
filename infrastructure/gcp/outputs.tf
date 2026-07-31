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
  value = local.use_domain ? "https://${local.app_host}" : "https://storage.googleapis.com/${google_storage_bucket.family_app.name}/index.html"
}

output "admin_url" {
  value = local.use_domain ? "https://${local.admin_host}" : "https://storage.googleapis.com/${google_storage_bucket.admin_app.name}/index.html"
}

output "load_balancer_ip" {
  description = "Point every hostname's A record at this address."
  value       = google_compute_global_address.lb.address
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

output "family_bucket" {
  value = google_storage_bucket.family_app.name
}

output "admin_bucket" {
  value = google_storage_bucket.admin_app.name
}

output "url_map" {
  description = "Target for CDN cache invalidation after a web deploy."
  value       = local.use_domain ? google_compute_url_map.main[0].name : ""
}

output "api_service_account" {
  value = google_service_account.api.email
}

output "stripe_webhook_url" {
  description = "Register this endpoint in the Stripe dashboard."
  value       = local.use_domain ? "https://${local.api_host}/api/payments/webhook" : "${google_cloud_run_v2_service.api.uri}/api/payments/webhook"
}
