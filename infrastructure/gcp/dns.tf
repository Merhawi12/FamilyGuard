# Cloud DNS — the Route 53 replacement. Optional: set manage_dns = false to keep
# the domain's nameservers where they are and create the API's A record by hand,
# pointing at the load_balancer_ip output.
#
# If you do delegate here, copy the name_servers output into your registrar.
# Nothing resolves — and the managed certificate never issues — until that is
# done.
#
# Only the API hostname is managed, even when manage_dns is true. The web
# hostnames belong to Firebase Hosting, which allocates a pair of addresses per
# connected domain at the moment you connect it; they are not derivable here, and
# guessing them would point the apex at nothing. Add them from what the Firebase
# console prints — docs/DEPLOYMENT.md §1.4 has the procedure.

resource "google_dns_managed_zone" "main" {
  count = local.use_domain && var.manage_dns ? 1 : 0

  name        = "${local.prefix}-zone"
  dns_name    = "${var.domain}."
  description = "Parentix ${var.env_name}"
  labels      = local.labels

  depends_on = [google_project_service.services]
}

resource "google_dns_record_set" "api" {
  count = local.use_domain && var.manage_dns ? 1 : 0

  name         = "${local.api_host}."
  managed_zone = google_dns_managed_zone.main[0].name
  type         = "A"
  # Short, so a load-balancer address change propagates quickly. This points at
  # an anycast IP that does not move in normal operation.
  ttl     = 300
  rrdatas = [google_compute_global_address.lb[0].address]
}
