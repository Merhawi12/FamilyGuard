# Alerting.
#
# Cloud Run and Cloud SQL already ship logs and metrics to Cloud Logging and
# Cloud Monitoring without any configuration — the service account's logWriter
# and metricWriter grants in iam.tf are what make the application's own log
# lines land there too. What none of that does is tell anyone when something
# breaks, which is the gap this file fills.
#
# Everything here is opt-in on `alert_email`. Alert policies attached to no
# notification channel are worse than no alert policies: they look like coverage
# in the console and reach nobody.

locals {
  alerting_enabled = var.alert_email != ""

  # An uptime check needs a public hostname to probe, so it can only exist once
  # the load balancer and its certificate do.
  uptime_enabled = local.alerting_enabled && local.use_domain
}

resource "google_monitoring_notification_channel" "email" {
  count = local.alerting_enabled ? 1 : 0

  display_name = "Parentix ${var.env_name} alerts"
  type         = "email"

  labels = {
    email_address = var.alert_email
  }

  depends_on = [google_project_service.services]
}

# ── Is the API answering at all? ─────────────────────────────────────────────

# Probes /api/health, which returns as soon as the process is up. /api/ready
# additionally checks the database, but a readiness failure is already covered
# by the error-rate policy below — probing it here would page for a slow query
# as loudly as for a dead service.
resource "google_monitoring_uptime_check_config" "api" {
  count = local.uptime_enabled ? 1 : 0

  display_name = "${local.prefix}-api-health"
  timeout      = "10s"
  period       = "60s"

  http_check {
    path         = "/api/health"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = local.api_host
    }
  }

  depends_on = [google_project_service.services]
}

resource "google_monitoring_alert_policy" "api_down" {
  count = local.uptime_enabled ? 1 : 0

  display_name = "${local.prefix} — API unreachable"
  combiner     = "OR"
  severity     = "CRITICAL"

  documentation {
    content   = <<-EOT
      The uptime check against https://${local.api_host}/api/health has been
      failing from multiple regions.

      Look at the Cloud Run revision first — `gcloud run services logs read
      ${local.prefix}-api --region ${var.region}` — then at whether Cloud SQL is
      up, since the API exits on a failed database connection at boot.
    EOT
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "Uptime check failing"

    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\"",
        "resource.type=\"uptime_url\"",
        "metric.label.check_id=\"${google_monitoring_uptime_check_config.api[0].uptime_check_id}\"",
      ])

      # check_passed is one BOOL stream per probe location, and the aggregation
      # has to keep it boolean: ALIGN_FRACTION_TRUE yields a DOUBLE, which the
      # count reducers reject outright ("The reducer cannot be applied to
      # metrics with value type DOUBLE"). ALIGN_NEXT_OLDER preserves the type,
      # and REDUCE_COUNT_FALSE then counts the locations reporting a failure.
      #
      # Firing above one failing location keeps a single unhealthy region quiet,
      # while a real outage fails every probe at once and trips it.
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "300s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email[0].id]

  alert_strategy {
    auto_close = "1800s"
  }
}

# ── Is it answering correctly? ───────────────────────────────────────────────

# Counts 5xx responses Cloud Run produced itself. A sustained run of them means
# the service is up but failing — an unhandled exception, an exhausted
# connection pool, a dependency that stopped answering.
resource "google_monitoring_alert_policy" "api_error_rate" {
  count = local.alerting_enabled ? 1 : 0

  display_name = "${local.prefix} — API 5xx responses"
  combiner     = "OR"
  severity     = "ERROR"

  documentation {
    content   = <<-EOT
      The API has been returning server errors steadily for five minutes.

      These are 5xx responses, so they are the API's own failures rather than
      bad requests. The global error handler logs the stack; filter Cloud
      Logging to `resource.labels.service_name="${local.prefix}-api"
      severity>=ERROR`.
    EOT
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "5xx responses sustained"

    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"run.googleapis.com/request_count\"",
        "resource.type=\"cloud_run_revision\"",
        "resource.label.service_name=\"${google_cloud_run_v2_service.api.name}\"",
        "metric.label.response_code_class=\"5xx\"",
      ])

      comparison = "COMPARISON_GT"
      # A per-second rate, so this is roughly one server error every two
      # seconds sustained for five minutes — comfortably above the occasional
      # one-off, and well below a rate any real user would tolerate.
      threshold_value = 0.5
      duration        = "300s"

      # Summed across revisions. Without the reducer each revision is judged on
      # its own, so a rollout splitting traffic in half could hide a fault that
      # the service as a whole is plainly showing. ALIGN_RATE yields a DOUBLE,
      # which REDUCE_SUM accepts.
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.service_name"]
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email[0].id]

  alert_strategy {
    auto_close = "1800s"
  }
}

# ── Is the database healthy? ─────────────────────────────────────────────────

# Disk is the one Cloud SQL resource whose exhaustion is not recoverable by
# retrying: Postgres stops accepting writes. disk_autoresize in database.tf
# should prevent this, but it has a ceiling, and this fires before the ceiling
# becomes an outage.
resource "google_monitoring_alert_policy" "db_disk" {
  count = local.alerting_enabled ? 1 : 0

  display_name = "${local.prefix} — Cloud SQL disk nearly full"
  combiner     = "OR"
  severity     = "WARNING"

  documentation {
    content   = <<-EOT
      The Cloud SQL instance is above 85% disk utilisation.

      Autoresize is on and will grow the disk up to
      ${var.db_disk_size_gb * 10} GB. Past that it stops, and Postgres stops
      accepting writes. Raise `db_disk_size_gb` or find what is growing.
    EOT
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "Disk utilisation above 85%"

    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"cloudsql.googleapis.com/database/disk/utilization\"",
        "resource.type=\"cloudsql_database\"",
        "resource.label.database_id=\"${var.project_id}:${google_sql_database_instance.main.name}\"",
      ])

      comparison      = "COMPARISON_GT"
      threshold_value = 0.85
      duration        = "300s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email[0].id]

  alert_strategy {
    auto_close = "1800s"
  }
}

resource "google_monitoring_alert_policy" "db_cpu" {
  count = local.alerting_enabled ? 1 : 0

  display_name = "${local.prefix} — Cloud SQL CPU saturated"
  combiner     = "OR"
  severity     = "WARNING"

  documentation {
    content   = <<-EOT
      The Cloud SQL instance has been above 90% CPU for fifteen minutes.

      Query Insights is enabled on the instance — start there to find the
      statement responsible before raising `db_tier`.
    EOT
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "CPU above 90%"

    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"cloudsql.googleapis.com/database/cpu/utilization\"",
        "resource.type=\"cloudsql_database\"",
        "resource.label.database_id=\"${var.project_id}:${google_sql_database_instance.main.name}\"",
      ])

      comparison = "COMPARISON_GT"
      # Fifteen minutes, not five: a backup or a migration can legitimately peg
      # the CPU for a while, and paging for those trains people to ignore it.
      threshold_value = 0.9
      duration        = "900s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email[0].id]

  alert_strategy {
    auto_close = "1800s"
  }
}
