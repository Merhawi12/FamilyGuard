# Cloud Scheduler — recurring work that must not depend on request traffic.
#
# The API has one recurring job: an hourly pass over every active parent looking
# for risk patterns. It used to run on a setInterval inside the process, which is
# right for a single long-lived server and wrong for Cloud Run in both
# directions:
#
#   scaled to zero   cpu_idle throttles the CPU between requests, so the timer
#                    never fires. Nothing logs an error — the job simply does not
#                    happen, and looks like a feature nobody uses.
#   scaled out       every warm instance runs its own copy. The pass is
#                    idempotent so the result is correct, but the work is done
#                    api_max_instances times over.
#
# Scheduler makes it exactly once, on a schedule that holds whether the service
# is warm or cold, with a retry and a recorded outcome for each run.

# cloudscheduler.googleapis.com is enabled with the rest in main.tf.

# A caller identity of its own rather than the API's service account. The token
# in the request names this account, so it doubles as the credential the endpoint
# checks — and an account that can do nothing but invoke Cloud Run is a much
# smaller thing to have leaked in a header than one that can read every secret.
resource "google_service_account" "scheduler" {
  account_id   = "${local.prefix}-scheduler"
  display_name = "Parentix scheduled jobs (${var.env_name})"

  depends_on = [google_project_service.services]
}

# Granted on the service, not the project: this account can invoke the API and
# nothing else that might later be deployed alongside it.
#
# This is belt to the endpoint's braces rather than the actual gate. The service
# is invokable by allUsers — Stripe's webhook and the child app both reach it
# without a Google identity — so Cloud Run admits the request regardless, and
# what stops anyone else running the job is routes/tasks.js verifying the OIDC
# token's audience and email. The grant is what keeps that arrangement working if
# the service is ever closed to unauthenticated callers.
resource "google_cloud_run_v2_service_iam_member" "scheduler_invoker" {
  name     = google_cloud_run_v2_service.api.name
  location = google_cloud_run_v2_service.api.location
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

# The .run.app URL, deliberately, not the custom domain.
#
# Scheduler is calling from inside Google's network and does not need to leave it
# to reach Cloud Run. Going via api.<domain> would route each run through the
# external load balancer, make the job depend on DNS and on a certificate that
# renews, and break the environments that have no domain at all.
locals {
  tasks_base_url = google_cloud_run_v2_service.api.uri
}

# The audience is a fixed identifier rather than the service's own URL.
#
# The obvious choice — the .run.app URL, which is what Cloud Run itself would
# check under IAM-only ingress — cannot be used: the service would have to carry
# its own URI in its own environment, and Terraform rejects that cycle outright.
#
# A constant costs nothing here. Cloud Run admits these calls without inspecting
# the token at all (the service is invokable by allUsers), so the audience is
# only ever read by routes/tasks.js, and its whole job is to be a value unique to
# this environment: a token minted for anything else fails the check. Being
# independent of the URL is a small bonus — the service can be recreated, or the
# domain changed, without the two sides disagreeing.
locals {
  tasks_audience = "https://${local.prefix}-tasks"
}

resource "google_cloud_scheduler_job" "safety_analysis" {
  name        = "${local.prefix}-safety-analysis"
  description = "Hourly risk-pattern pass over active parents"
  region      = var.region

  # On the hour. The pass only raises an alert that does not already exist, so a
  # run that overlaps a previous one is harmless.
  schedule  = "0 * * * *"
  time_zone = "Etc/UTC"

  # The job runs to completion before answering — a fleet of this size takes
  # seconds, and a timeout shorter than the work would retry a pass that was
  # about to succeed.
  attempt_deadline = "320s"

  retry_config {
    retry_count          = 3
    min_backoff_duration = "30s"
    max_backoff_duration = "300s"
    # An hourly job has an hour before the next run; there is no value in
    # retrying past that, and the following run does the same work anyway.
    max_retry_duration = "600s"
  }

  http_target {
    http_method = "POST"
    uri         = "${local.tasks_base_url}/api/tasks/safety-analysis"

    headers = {
      "Content-Type" = "application/json"
    }

    body = base64encode(jsonencode({ source = "cloud-scheduler" }))

    # An identity token, not an access token. The endpoint verifies the
    # signature, the audience and the account's email — see routes/tasks.js.
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      # The same local that feeds TASKS_AUDIENCE on the service, so the two
      # cannot drift. A mismatch fails the audience check and every run returns
      # 401 — recorded in the Scheduler job's history rather than in the API's
      # logs, which is worth knowing before debugging the wrong side.
      audience = local.tasks_audience
    }
  }

  depends_on = [
    google_project_service.services,
    google_cloud_run_v2_service_iam_member.scheduler_invoker,
  ]
}
