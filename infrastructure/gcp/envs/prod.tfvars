# Production.
#
#   PROJECT_ID=<project> ./deploy.sh prod plan
#
# Set `domain` before the first apply. Changing it later replaces the managed
# certificate and the URL map, which means a window where the old hostnames stop
# resolving — cheap to get right up front, disruptive to change afterwards.

project_id = "parentix-4be0d"
env_name   = "prod"
region     = "us-central1"

domain          = "parentix.ca"
app_subdomain   = "app"
admin_subdomain = "admin"
api_subdomain   = "api"

# Set true only if you delegate the domain's nameservers to Cloud DNS. Leave
# false to keep DNS at your registrar and create three A records by hand.
manage_dns = false

# At least one warm instance: a cold start on a real user's login is a bad first
# impression, and a scaled-to-zero service drops every open websocket.
api_min_instances = 1
api_max_instances = 6
api_cpu           = "1"
api_memory        = "1Gi"

# 1 vCPU / 3.75 GB. db-f1-micro is a shared-core instance with no performance
# guarantee and is not suitable for production traffic.
#
# ENTERPRISE_PLUS would add a data cache and near-zero-downtime maintenance, but
# only accepts db-perf-optimized-N-* tiers, which start considerably higher.
db_edition = "ENTERPRISE"
db_tier    = "db-custom-1-3840"

db_disk_size_gb = 20
# Synchronous standby in a second zone. Roughly doubles the database cost and is
# the difference between a zone failure being a blip and being an outage.
db_availability_type     = "REGIONAL"
db_backup_retention_days = 14
db_deletion_protection   = true

# Required: more than one API instance means Socket.IO events have to cross
# instances. Adds roughly $35/month.
redis_enabled        = true
redis_memory_size_gb = 1

email_from = "Parentix <no-reply@parentix.ca>"

labels = {
  cost-center = "production"
}
