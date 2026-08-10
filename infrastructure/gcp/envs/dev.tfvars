# Development. Sized to be cheap rather than resilient — scales to zero, one
# zone, no Redis. Roughly $10-15/month when idle, most of it Cloud SQL.
#
#   PROJECT_ID=<project> ./deploy.sh dev plan

project_id = "parentix-4be0d"
env_name   = "dev"
region     = "us-central1"

# No custom domain: the API is reached on its .run.app URL and the web apps on
# their bucket URLs. No load balancer, no certificate, nothing to wait for.
domain     = ""
manage_dns = false

# Scale to zero when idle. The first request after a quiet spell pays a cold
# start of a few seconds.
api_min_instances = 0
api_max_instances = 2
api_cpu           = "1"
api_memory        = "512Mi"

# Shared-core, and the cheapest thing that runs Postgres. Valid only on the
# ENTERPRISE edition — ENTERPRISE_PLUS rejects it.
db_edition               = "ENTERPRISE"
db_tier                  = "db-f1-micro"
db_disk_size_gb          = 10
db_availability_type     = "ZONAL"
db_backup_retention_days = 3
db_deletion_protection   = false

# One API instance at a time, so Socket.IO needs no cross-instance fan-out.
redis_enabled = false

email_from = "Parentix Dev <no-reply@parentix.ca>"

labels = {
  cost-center = "engineering"
}

# ── Firebase Hosting ─────────────────────────────────────────────────────────
# Development shares the Hosting sites and uses preview channels rather than
# sites of its own:
#   firebase hosting:channel:deploy dev --only family --expires 30d
# Those channel URLs are minted per deploy and cannot be derived here, so add the
# one you are using to extra_cors_origins while you need it.
firebase_family_site = "parentix-4be0d"
firebase_admin_site  = "parentix-admin"

extra_cors_origins = []
