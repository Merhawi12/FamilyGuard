# Cloud Run — the ECS Fargate replacement.

resource "google_cloud_run_v2_service" "api" {
  name     = "${local.prefix}-api"
  location = var.region

  # Requests reach this service through the load balancer; the .run.app URL
  # stays reachable too, which is what a no-domain deployment uses.
  ingress = "INGRESS_TRAFFIC_ALL"

  labels = local.labels

  template {
    service_account = google_service_account.api.email

    scaling {
      min_instance_count = var.api_min_instances
      max_instance_count = var.api_max_instances
    }

    # Socket.IO holds a connection open for the life of a session. The default
    # 5-minute request timeout would sever every websocket; 60 minutes is the
    # Cloud Run maximum, and the client reconnects when it is hit.
    timeout = "3600s"

    # Node handles concurrency fine, and Socket.IO connections are cheap to
    # hold. A low value here would spin up an instance per handful of sockets.
    max_instance_request_concurrency = 80

    # Socket.IO opens with HTTP long-polling and only then upgrades to a
    # websocket. Those first requests must all land on the same instance or the
    # handshake fails intermittently once more than one instance is running.
    # Serverless NEGs do not support load-balancer session affinity, so this —
    # Cloud Run's own best-effort affinity — is the knob that matters.
    session_affinity = true

    # Cloud SQL Auth Proxy socket, mounted at /cloudsql/<connection-name>.
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.main.connection_name]
      }
    }

    dynamic "vpc_access" {
      for_each = local.need_vpc ? [1] : []
      content {
        connector = google_vpc_access_connector.main[0].id
        # Only VPC-destined traffic uses the connector. Routing all egress
        # through it would need a Cloud NAT for everything else — Stripe, SMTP,
        # the Google APIs — and bill for the throughput.
        egress = "PRIVATE_RANGES_ONLY"
      }
    }

    containers {
      image = local.api_image

      ports {
        container_port = 5000
      }

      resources {
        limits = {
          cpu    = var.api_cpu
          memory = var.api_memory
        }
        # CPU only while a request is in flight — cheaper, but background timers
        # stall between requests. The API's scheduled work runs on request
        # traffic, so this is safe; flip to true if that ever changes.
        cpu_idle          = var.api_min_instances == 0
        startup_cpu_boost = true
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      # PORT is deliberately absent. Cloud Run reserves it and injects it from
      # ports.container_port above, and setting it explicitly is rejected at
      # create time. src/config/env.js reads process.env.PORT, so the container
      # picks up 5000 from Cloud Run rather than from here.
      # Exactly one proxy hop in front of Express: the external load balancer.
      env {
        name  = "TRUST_PROXY"
        value = "1"
      }
      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "GCP_REGION"
        value = var.region
      }

      # ── Database: Unix socket, so no host, port or TLS settings ──
      env {
        name  = "DB_SOCKET_PATH"
        value = "/cloudsql/${google_sql_database_instance.main.connection_name}"
      }
      env {
        name  = "DB_NAME"
        value = google_sql_database.parentix.name
      }
      env {
        name  = "DB_USER"
        value = google_sql_user.api.name
      }
      env {
        name = "DB_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.generated["db-password"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name  = "REDIS_URL"
        value = var.redis_enabled ? "redis://:${google_redis_instance.main[0].auth_string}@${google_redis_instance.main[0].host}:${google_redis_instance.main[0].port}" : ""
      }

      # ── Browser origins ──
      #
      # Firebase Hosting serves the web apps and Cloud Run serves this, so every
      # call from a browser is cross-origin and this list is the whole of what
      # the API will accept. One Family App deployment answers on the apex, www
      # and app.<domain>, hence a comma-separated value rather than a single URL.
      #
      # The first entry is load-bearing beyond CORS: it is the origin the API
      # builds links against — the password-reset email and Stripe's return URL
      # — so app.<domain> leads.
      #
      # Naming these explicitly matters even without a custom domain: the API
      # withholds its localhost CORS defaults in production, so an empty value
      # would leave a deployed service with no allowed origins, and it refuses to
      # start rather than serve one.
      env {
        name  = "CLIENT_URL"
        value = join(",", local.client_origins)
      }
      env {
        name  = "ADMIN_URL"
        value = join(",", local.admin_origins)
      }
      # The *.web.app names, plus anything extra_cors_origins adds. Kept separate
      # from the two above because ADMIN_URL's first entry is read on its own as
      # the console's address.
      env {
        name  = "CORS_ORIGINS"
        value = join(",", local.cors_origins)
      }

      # Public client IDs, not credentials — see variables.tf. Plain environment
      # variables rather than secrets so that a change is a one-line tfvars edit
      # and a redeploy, not a new secret version.
      env {
        name  = "GOOGLE_CLIENT_ID"
        value = var.google_client_id
      }
      env {
        name  = "GOOGLE_EXTRA_CLIENT_IDS"
        value = join(",", var.google_extra_client_ids)
      }

      # ── Recurring jobs ──
      #
      # Cloud Scheduler drives them, so the in-process timer stays off. See
      # scheduler.tf for why a setInterval is wrong on Cloud Run specifically,
      # and routes/tasks.js for how the incoming call is authenticated.
      env {
        name  = "JOB_RUNNER"
        value = "external"
      }
      env {
        name  = "SCHEDULER_SERVICE_ACCOUNT"
        value = google_service_account.scheduler.email
      }
      env {
        name  = "TASKS_AUDIENCE"
        value = local.tasks_audience
      }

      env {
        name  = "STORAGE_PROVIDER"
        value = "gcs"
      }
      env {
        name  = "GCS_BUCKET"
        value = google_storage_bucket.uploads.name
      }

      env {
        name  = "EMAIL_PROVIDER"
        value = "smtp"
      }
      env {
        name  = "EMAIL_FROM"
        value = var.email_from
      }
      env {
        name  = "ADMIN_EMAIL"
        value = var.admin_email
      }

      dynamic "env" {
        for_each = {
          JWT_SECRET              = google_secret_manager_secret.generated["jwt-secret"].secret_id
          FIELD_ENCRYPTION_KEY    = google_secret_manager_secret.generated["field-encryption-key"].secret_id
          STRIPE_SECRET_KEY       = google_secret_manager_secret.supplied["stripe-secret-key"].secret_id
          STRIPE_WEBHOOK_SECRET   = google_secret_manager_secret.supplied["stripe-webhook-secret"].secret_id
          STRIPE_PREMIUM_PRICE_ID = google_secret_manager_secret.supplied["stripe-premium-price-id"].secret_id
          STRIPE_FAMILY_PRICE_ID  = google_secret_manager_secret.supplied["stripe-family-price-id"].secret_id
          SMTP_HOST               = google_secret_manager_secret.supplied["smtp-host"].secret_id
          SMTP_USER               = google_secret_manager_secret.supplied["smtp-user"].secret_id
          SMTP_PASS               = google_secret_manager_secret.supplied["smtp-pass"].secret_id
          VAPID_PUBLIC_KEY        = google_secret_manager_secret.supplied["vapid-public-key"].secret_id
          VAPID_PRIVATE_KEY       = google_secret_manager_secret.supplied["vapid-private-key"].secret_id

          # The database server's certificate, for a deployment that reaches
          # Postgres over TCP instead of the Cloud SQL socket. Mounted
          # unconditionally like the Twilio block below: until a real version is
          # added it is the single-space placeholder, which `env.db.sslCa` trims
          # to empty, so nothing changes. Adding the version is the whole of
          # turning certificate verification on.
          DB_SSL_CA               = google_secret_manager_secret.supplied["db-ssl-ca"].secret_id

          # Phone sign-in. Mounted unconditionally: until a real version is
          # added each of these is the single-space placeholder, which `secret()`
          # trims to empty, so `isEnabled()` stays false and the API reports
          # phone sign-in as unavailable rather than half-working. Adding the
          # versions is the whole of turning the feature on.
          TWILIO_ACCOUNT_SID           = google_secret_manager_secret.supplied["twilio-account-sid"].secret_id
          TWILIO_AUTH_TOKEN            = google_secret_manager_secret.supplied["twilio-auth-token"].secret_id
          TWILIO_FROM_NUMBER           = google_secret_manager_secret.supplied["twilio-from-number"].secret_id
          TWILIO_MESSAGING_SERVICE_SID = google_secret_manager_secret.supplied["twilio-messaging-service-sid"].secret_id
        }
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      # TCP rather than HTTP, so the probe does not assume the container serves
      # /api/health — the bootstrap image on a first apply does not. It gives
      # the same guarantee either way: src/server.js only calls listen() after
      # initializeDatabase() has finished, so an open port means migrations are
      # done.
      startup_probe {
        tcp_socket {
          port = 5000
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        # Migrations run at boot; a cold Cloud SQL instance plus a schema change
        # can take a while, and failing the probe would loop the revision.
        failure_threshold = 30
        timeout_seconds   = 3
      }

      liveness_probe {
        http_get {
          path = "/api/health"
        }
        period_seconds    = 30
        failure_threshold = 3
        timeout_seconds   = 3
      }
    }
  }

  # Every deploy sends all traffic to the newest revision.
  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  lifecycle {
    # deploy-api.sh moves the image tag forward outside Terraform, so a later
    # `terraform apply` must not drag the service back to whatever tag was in
    # the variables at the time.
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_project_service.services,
    google_secret_manager_secret_version.generated,
    google_secret_manager_secret_version.supplied_placeholder,
    google_secret_manager_secret_iam_member.api_generated,
    google_secret_manager_secret_iam_member.api_supplied,
  ]
}

# The API is public — it authenticates its own callers with JWTs, and the child
# app and Stripe webhooks both need to reach it without a Google identity.
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.api.name
  location = google_cloud_run_v2_service.api.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}
