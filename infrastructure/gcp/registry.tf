# Artifact Registry — the ECR replacement. Holds the API image.

resource "google_artifact_registry_repository" "api" {
  location      = var.region
  repository_id = local.prefix
  format        = "DOCKER"
  description   = "Parentix API container images (${var.env_name})"

  # Keep the images a rollback might need; drop the rest. Without this the
  # repository grows without bound and is billed by the gigabyte.
  cleanup_policies {
    id     = "keep-recent-releases"
    action = "KEEP"
    most_recent_versions {
      keep_count = 20
    }
  }

  cleanup_policies {
    id     = "delete-old-untagged"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "604800s" # 7 days
    }
  }

  labels = local.labels

  depends_on = [google_project_service.services]
}
