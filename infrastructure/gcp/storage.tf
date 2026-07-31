# Three buckets: user uploads (private, signed access) and one per web app
# (public, fronted by the load balancer's CDN).

# ── User uploads ─────────────────────────────────────────────────────────────
resource "google_storage_bucket" "uploads" {
  name     = "${local.prefix}-uploads-${var.project_id}"
  location = var.region

  # Private. Objects are written with signed PUT URLs and read through signed
  # URLs or the CDN — never by being world-readable.
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  # Old versions of a replaced avatar have no value after a month, but they do
  # keep costing money.
  lifecycle_rule {
    condition {
      num_newer_versions = 2
      with_state         = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  lifecycle_rule {
    condition {
      age        = 30
      with_state = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  # The browser PUTs directly to this bucket from the app origin, so the bucket
  # itself must allow that origin — the API signing the URL is not enough.
  cors {
    origin          = local.use_domain ? ["https://${local.app_host}", "https://${local.admin_host}"] : ["*"]
    method          = ["GET", "PUT", "HEAD"]
    response_header = ["Content-Type", "Content-Length"]
    max_age_seconds = 3600
  }

  labels = local.labels

  depends_on = [google_project_service.services]
}

# ── Web app buckets ──────────────────────────────────────────────────────────

resource "google_storage_bucket" "family_app" {
  name     = "${local.prefix}-family-${var.project_id}"
  location = var.region

  uniform_bucket_level_access = true

  website {
    # The marketing page is the site root, not the React app — this reproduces
    # the rewrite in apps/family-app/vite.config.js so dev and production agree.
    main_page_suffix = "landing.html"

    # Client-side routes have no matching object, so the SPA shell is served
    # instead. Caveat: a backend bucket returns HTTP 404 alongside it. Browsers
    # render it and routing works, but crawlers see a 404 on deep links. Moving
    # the web tier to Firebase Hosting is the fix if that ever matters.
    not_found_page = "index.html"
  }

  labels = local.labels

  depends_on = [google_project_service.services]
}

resource "google_storage_bucket" "admin_app" {
  name     = "${local.prefix}-admin-${var.project_id}"
  location = var.region

  uniform_bucket_level_access = true

  website {
    main_page_suffix = "index.html"
    not_found_page   = "index.html"
  }

  labels = local.labels

  depends_on = [google_project_service.services]
}

# The CDN reads these buckets as an anonymous caller, so their objects must be
# publicly readable. Both hold only compiled front-end assets that are served to
# every visitor anyway.
resource "google_storage_bucket_iam_member" "family_public" {
  bucket = google_storage_bucket.family_app.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

resource "google_storage_bucket_iam_member" "admin_public" {
  bucket = google_storage_bucket.admin_app.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}
