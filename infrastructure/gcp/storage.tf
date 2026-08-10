# One bucket: user uploads, private, reached only through signed URLs.
#
# The two web apps used to have a public bucket each, fronted by the load
# balancer's CDN. Firebase Hosting serves them now — it does the same job with
# its own CDN, its own certificates and atomic releases — so those buckets and
# their backend services are gone rather than kept alongside as a second way to
# publish the same files.

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
  # itself must allow that origin — the API signing the URL is not enough. The
  # same list the API answers with, because it is the same set of pages doing the
  # uploading; a name allowed by one and not the other fails at the second step,
  # after the signature has already been handed out.
  cors {
    origin          = length(local.cors_origins) > 0 ? local.cors_origins : ["*"]
    method          = ["GET", "PUT", "HEAD"]
    response_header = ["Content-Type", "Content-Length"]
    max_age_seconds = 3600
  }

  labels = local.labels

  depends_on = [google_project_service.services]
}
