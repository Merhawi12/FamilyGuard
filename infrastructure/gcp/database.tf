# Cloud SQL for PostgreSQL — the RDS replacement.
#
# Cloud Run reaches it through the built-in Cloud SQL socket integration (see
# run.tf), not over the network: an authenticated, encrypted connection made by
# the Cloud SQL Auth Proxy inside the instance sandbox. That is why the instance
# has no authorized networks and needs no VPC — the public endpoint exists but
# nothing on the internet can open a session against it.

resource "random_password" "db" {
  length = 32
  # Cloud SQL rejects some punctuation in passwords, and the value ends up in a
  # URL, so keep it to characters that survive both.
  override_special = "-_.~"
}

resource "google_sql_database_instance" "main" {
  name             = "${local.prefix}-pg"
  database_version = "POSTGRES_16"
  region           = var.region

  deletion_protection = var.db_deletion_protection

  settings {
    # Stated explicitly on purpose. The API now defaults new instances to
    # ENTERPRISE_PLUS, which accepts only db-perf-optimized-N-* tiers, so
    # omitting this makes a perfectly valid db-f1-micro fail at create time
    # with "Invalid Tier for (ENTERPRISE_PLUS) Edition".
    edition           = var.db_edition
    tier              = var.db_tier
    availability_type = var.db_availability_type
    disk_size         = var.db_disk_size_gb
    disk_type         = "PD_SSD"
    # Running out of disk takes Postgres down hard; growing it is cheap.
    disk_autoresize       = true
    disk_autoresize_limit = var.db_disk_size_gb * 10

    user_labels = local.labels

    # The second of two independent guards, and the one that covers the case the
    # first cannot.
    #
    # `deletion_protection` above is a Terraform-side flag: it makes *this*
    # configuration refuse to destroy the instance. It is invisible to anyone
    # outside Terraform, so a `gcloud sql instances delete` — or a console click
    # — drops the production database with it set. This one is enforced by Cloud
    # SQL itself and refuses the delete whatever asks for it.
    #
    # Both are driven by the same variable because "may this instance be
    # deleted?" is one decision, not two.
    deletion_protection_enabled = var.db_deletion_protection

    backup_configuration {
      enabled    = true
      start_time = "03:00"
      # Write-ahead log archiving. Without it, backups restore only to the
      # nightly snapshot; with it, to any second inside the retention window.
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = min(var.db_backup_retention_days, 7)

      backup_retention_settings {
        retained_backups = var.db_backup_retention_days
        retention_unit   = "COUNT"
      }
    }

    ip_configuration {
      # No authorized_networks block at all: with an empty allow-list nothing on
      # the internet can open a session. Access is exclusively through the Auth
      # Proxy, which authenticates with IAM rather than a network ACL.
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    maintenance_window {
      day          = 7 # Sunday
      hour         = 4
      update_track = "stable"
    }

    insights_config {
      query_insights_enabled  = true
      record_application_tags = false
      record_client_address   = false
    }
  }

  depends_on = [google_project_service.services]

  lifecycle {
    # The instance name cannot be reused for about a week after deletion, so an
    # accidental replacement is genuinely disruptive.
    prevent_destroy = false
  }
}

resource "google_sql_database" "parentix" {
  name     = "parentix"
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "api" {
  name     = "parentix"
  instance = google_sql_database_instance.main.name
  password = random_password.db.result
}
