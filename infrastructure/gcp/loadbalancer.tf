# Global external Application Load Balancer — the CloudFront + ALB replacement.
#
# One anycast IP fronts all three hostnames:
#
#   app.<domain>    → family bucket   (+ /api, /socket.io → Cloud Run)
#   admin.<domain>  → admin bucket    (+ /api, /socket.io → Cloud Run)
#   api.<domain>    → Cloud Run
#
# Serving the API on the same origin as each SPA is what lets the front-end
# builds leave VITE_API_URL empty: no CORS preflight on every call, and no
# third-party cookie handling.
#
# None of this is created without a domain — a managed certificate needs one.

# ── Backends ─────────────────────────────────────────────────────────────────

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

resource "google_compute_backend_bucket" "family" {
  count = local.use_domain ? 1 : 0

  name        = "${local.prefix}-family-backend"
  bucket_name = google_storage_bucket.family_app.name
  enable_cdn  = true

  cdn_policy {
    # Honour the Cache-Control headers deploy-web.sh sets at upload time:
    # one year for hashed assets, no-cache for the HTML entry points. Getting
    # that wrong means browsers keep loading the previous build's script tags.
    cache_mode       = "USE_ORIGIN_HEADERS"
    negative_caching = true
  }
}

resource "google_compute_backend_bucket" "admin" {
  count = local.use_domain ? 1 : 0

  name        = "${local.prefix}-admin-backend"
  bucket_name = google_storage_bucket.admin_app.name
  enable_cdn  = true

  cdn_policy {
    cache_mode       = "USE_ORIGIN_HEADERS"
    negative_caching = true
  }
}

# ── Routing ──────────────────────────────────────────────────────────────────

resource "google_compute_url_map" "main" {
  count = local.use_domain ? 1 : 0

  name = "${local.prefix}-urlmap"

  # Anything that matches no host rule lands on the marketing site.
  default_service = google_compute_backend_bucket.family[0].id

  host_rule {
    hosts        = [local.app_host]
    path_matcher = "family"
  }

  host_rule {
    hosts        = [local.admin_host]
    path_matcher = "admin"
  }

  host_rule {
    hosts        = [local.api_host]
    path_matcher = "api"
  }

  path_matcher {
    name            = "family"
    default_service = google_compute_backend_bucket.family[0].id

    path_rule {
      paths   = ["/api", "/api/*"]
      service = google_compute_backend_service.api[0].id
    }

    path_rule {
      paths   = ["/socket.io", "/socket.io/*"]
      service = google_compute_backend_service.api[0].id
    }

    # `/` is handled by the bucket's main_page_suffix (landing.html), but
    # `/contact` has no such hook — it needs an explicit rewrite to the static
    # file, matching what apps/family-app/vite.config.js does in development.
    path_rule {
      paths   = ["/contact"]
      service = google_compute_backend_bucket.family[0].id

      route_action {
        url_rewrite {
          path_prefix_rewrite = "/contact.html"
        }
      }
    }
  }

  path_matcher {
    name            = "admin"
    default_service = google_compute_backend_bucket.admin[0].id

    path_rule {
      paths   = ["/api", "/api/*"]
      service = google_compute_backend_service.api[0].id
    }

    path_rule {
      paths   = ["/socket.io", "/socket.io/*"]
      service = google_compute_backend_service.api[0].id
    }
  }

  path_matcher {
    name            = "api"
    default_service = google_compute_backend_service.api[0].id
  }
}

# ── TLS and front end ────────────────────────────────────────────────────────

resource "google_compute_managed_ssl_certificate" "main" {
  count = local.use_domain ? 1 : 0

  name = "${local.prefix}-cert"

  # The bare domain is included because it is what people type. The URL map's
  # default_service is already the family bucket, so parentix.ca serves the
  # marketing site without a host rule of its own — it only ever needed a
  # certificate that covers it.
  #
  # Every name here must resolve to the load balancer before Google will issue:
  # one unvalidated domain holds up the whole certificate, not just itself. So
  # the apex A record has to exist first. Adding a name here also REPLACES the
  # certificate and restarts provisioning for all of them.
  managed {
    domains = [var.domain, local.app_host, local.admin_host, local.api_host]
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

  name             = "${local.prefix}-https-proxy"
  url_map          = google_compute_url_map.main[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.main[0].id]
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
# session cookie travel in the clear once.
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
