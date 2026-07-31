# Cloud DNS — the Route 53 replacement. Optional: set manage_dns = false to keep
# the domain's nameservers where they are and create three A records by hand
# pointing at the load_balancer_ip output.
#
# If you do delegate here, copy the name_servers output into your registrar.
# Nothing resolves — and the managed certificate never issues — until that is
# done.

resource "google_dns_managed_zone" "main" {
  count = local.use_domain && var.manage_dns ? 1 : 0

  name        = "${local.prefix}-zone"
  dns_name    = "${var.domain}."
  description = "Parentix ${var.env_name}"
  labels      = local.labels

  depends_on = [google_project_service.services]
}

resource "google_dns_record_set" "hosts" {
  for_each = local.use_domain && var.manage_dns ? toset([
    local.app_host,
    local.admin_host,
    local.api_host,
  ]) : toset([])

  name         = "${each.value}."
  managed_zone = google_dns_managed_zone.main[0].name
  type         = "A"
  # Short, so a load-balancer address change propagates quickly. These records
  # point at an anycast IP that does not move in normal operation.
  ttl     = 300
  rrdatas = [google_compute_global_address.lb.address]
}
