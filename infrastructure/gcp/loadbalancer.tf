# Global external Application Load Balancer, fronting the API and nothing else.
#
#   api.<domain>  → Cloud Run
#
# The two web apps are served by Firebase Hosting, which has its own anycast
# addresses, its own managed certificates and its own CDN. So the only hostname
# that resolves here is the API's, and this file no longer carries backend
# buckets, host rules or path matchers — there is one backend and everything
# arriving is for it.
#
# Because the apps and the API are now separate origins, every browser call is a
# genuine cross-origin request. That is answered by the CORS allowlist the API is
# configured with in run.tf, not by routing.
#
# None of this is created without a domain — a managed certificate needs one. In
# a domainless environment the API is reached on its .run.app URL instead, which
# already has a certificate of Google's.

# ── Backend ──────────────────────────────────────────────────────────────────

resource "google_compute_region_network_endpoint_group" "api" {
  count = local.use_domain ? 1 : 0

  name                  = "${local.prefix}-api-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.api.name
  }
}

resource "google_compute_backend_service" "api" {
  count = local.use_domain ? 1 : 0

  name                  = "${local.prefix}-api-backend"
  protocol              = "HTTPS"
  load_balancing_scheme = "EXTERNAL_MANAGED"

  # No timeout_sec here on purpose. A backend service fronting a serverless NEG
  # rejects the field outright — "Timeout sec is not supported for a backend
  # service with Serverless network endpoint groups" — because the load balancer
  # does not impose its own limit on this path. What a Socket.IO connection
  # actually lives under is the Cloud Run request timeout, set to 3600s in
  # run.tf; that is the only timeout in play.
  #
  # Socket.IO reaching Cloud Run directly, rather than through Firebase Hosting,
  # is not incidental: Firebase Hosting does not proxy a websocket upgrade, so a
  # rewrite from the app's own origin would hold the realtime layer down to
  # long-polling. The client connects to this hostname for that reason.

  backend {
    group = google_compute_region_network_endpoint_group.api[0].id
  }

  # API responses are per-user and must never be cached at the edge.
  enable_cdn = false

  log_config {
    enable      = true
    sample_rate = var.env_name == "prod" ? 0.1 : 1.0
  }
}

# ── Routing ──────────────────────────────────────────────────────────────────

resource "google_compute_url_map" "main" {
  count = local.use_domain ? 1 : 0

  name = "${local.prefix}-urlmap"

  # One backend, so no host rules: whatever reaches this address is API traffic,
  # and a request for a hostname that no longer points here gets the API's own
  # 404 rather than somebody else's page.
  default_service = google_compute_backend_service.api[0].id
}

# ── TLS and front end ────────────────────────────────────────────────────────

resource "google_compute_managed_ssl_certificate" "main" {
  count = local.use_domain ? 1 : 0

  # The domain list is part of the name. A managed certificate's `domains` field
  # forces replacement, and a replacement whose name collides with the resource
  # being replaced cannot be created first — which is exactly what
  # create_before_destroy needs to do. Deriving the suffix from the list means
  # the new certificate always has a free name.
  name = "${local.prefix}-cert-${substr(sha256(join(",", local.certificate_domains)), 0, 8)}"

  # The API alone. The apex and the app hostnames are Firebase Hosting's now, and
  # each one left on this certificate would be a domain Google re-validates
  # against this load balancer and cannot reach — a validation failure blocks
  # renewal for every name on the certificate, not just the unreachable one, so
  # leaving them here would eventually take HTTPS down on the API too.
  managed {
    domains = local.certificate_domains
  }

  # Google will not issue until each name resolves to the address below, so the
  # certificate sits in PROVISIONING — sometimes for 15-60 minutes — after the
  # DNS records appear. A replacement must exist before the old one goes.
  lifecycle {
    create_before_destroy = true
  }
}

# Guarded like everything else here: a reserved global address is billed even
# when nothing is attached to it, so creating one in an environment with no load
# balancer is a standing charge for an IP that routes nowhere.
resource "google_compute_global_address" "lb" {
  count = local.use_domain ? 1 : 0

  name = "${local.prefix}-lb-ip"

  depends_on = [google_project_service.services]
}

resource "google_compute_target_https_proxy" "main" {
  count = local.use_domain ? 1 : 0

  name    = "${local.prefix}-https-proxy"
  url_map = google_compute_url_map.main[0].id

  # Normally one certificate. `retained_ssl_certificate` attaches a second for
  # the duration of a certificate change, so the proxy keeps serving from the
  # outgoing one while the incoming one provisions — see the variable's
  # description for the two-apply procedure.
  ssl_certificates = compact([
    google_compute_managed_ssl_certificate.main[0].id,
    var.retained_ssl_certificate != ""
    ? "projects/${var.project_id}/global/sslCertificates/${var.retained_ssl_certificate}"
    : "",
  ])
}

resource "google_compute_global_forwarding_rule" "https" {
  count = local.use_domain ? 1 : 0

  name                  = "${local.prefix}-https"
  target                = google_compute_target_https_proxy.main[0].id
  ip_address            = google_compute_global_address.lb[0].id
  port_range            = "443"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

# Plain HTTP exists only to redirect. Serving anything over it would let a
# bearer token travel in the clear once.
resource "google_compute_url_map" "redirect" {
  count = local.use_domain ? 1 : 0

  name = "${local.prefix}-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  count = local.use_domain ? 1 : 0

  name    = "${local.prefix}-http-proxy"
  url_map = google_compute_url_map.redirect[0].id
}

resource "google_compute_global_forwarding_rule" "http" {
  count = local.use_domain ? 1 : 0

  name                  = "${local.prefix}-http"
  target                = google_compute_target_http_proxy.redirect[0].id
  ip_address            = google_compute_global_address.lb[0].id
  port_range            = "80"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}
