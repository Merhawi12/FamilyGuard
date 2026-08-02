variable "project_id" {
  description = "Google Cloud project ID."
  type        = string
}

variable "env_name" {
  description = "Environment name; prefixes every resource. dev | prod."
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.env_name)
    error_message = "env_name must be dev or prod."
  }
}

variable "region" {
  description = <<-EOT
    Region for Cloud Run, Cloud SQL, Memorystore and Artifact Registry.

    us-central1 is the cheapest and gets features first. If Canadian data
    residency matters for a product handling children's data, use
    northamerica-northeast1 (Montreal) instead — everything here supports it,
    at slightly higher cost.
  EOT
  type        = string
  default     = "us-central1"
}

# ── Domains ──────────────────────────────────────────────────────────────────

variable "domain" {
  description = <<-EOT
    Apex domain, e.g. "parentix.ca". Leave empty to deploy without custom
    domains: the API is then reachable on its generated *.run.app URL and the
    web apps directly on their bucket URLs, with no managed certificate and no
    CDN. Useful for a first smoke test, not for production — and note the child
    app pins an https:// API hostname, so it needs a real domain.
  EOT
  type        = string
  default     = ""
}

variable "app_subdomain" {
  description = "Family app hostname prefix."
  type        = string
  default     = "app"
}

variable "admin_subdomain" {
  description = "Admin dashboard hostname prefix."
  type        = string
  default     = "admin"
}

variable "api_subdomain" {
  description = "API hostname prefix. The child app is pinned to this name."
  type        = string
  default     = "api"
}

variable "manage_dns" {
  description = <<-EOT
    Create a Cloud DNS managed zone and the A records for the load balancer.
    Set false if the domain's nameservers stay with your current registrar — you
    then create one A record per hostname by hand, pointing at the
    load_balancer_ip output.
  EOT
  type        = bool
  default     = false
}

# ── API (Cloud Run) ──────────────────────────────────────────────────────────

variable "api_image" {
  description = <<-EOT
    Full Artifact Registry image reference for the API. Defaults to the :latest
    tag in the repository this config creates. deploy-api.sh overrides it with a
    commit-pinned tag so a rollback is just a redeploy of an older one.
  EOT
  type        = string
  default     = ""
}

variable "api_cpu" {
  description = "vCPU per Cloud Run instance."
  type        = string
  default     = "1"
}

variable "api_memory" {
  description = "Memory per Cloud Run instance."
  type        = string
  default     = "512Mi"
}

variable "api_min_instances" {
  description = <<-EOT
    Instances kept warm. 0 lets the service scale to zero, which is the big
    Cloud Run saving — but the first request after idle pays a cold start, and
    an idle Socket.IO client is disconnected when the instance goes away.
    Use 0 for dev, at least 1 for prod.
  EOT
  type        = number
  default     = 0
}

variable "api_max_instances" {
  description = "Upper bound on concurrent instances — the cost ceiling."
  type        = number
  default     = 4
}

# ── Database (Cloud SQL) ─────────────────────────────────────────────────────

variable "db_edition" {
  description = <<-EOT
    Cloud SQL edition. Must be stated explicitly: the API's own default has
    moved to ENTERPRISE_PLUS, which rejects every tier except the
    db-perf-optimized-N-* family — so leaving this unset makes an otherwise
    valid db-f1-micro or db-custom-* fail at create time.

    ENTERPRISE covers shared-core (db-f1-micro, db-g1-small) and custom
    (db-custom-N-M) tiers, and is what this deployment sizes for.
    ENTERPRISE_PLUS buys a data cache and near-zero-downtime maintenance at
    substantially higher cost, and would need the tier changed to match.
  EOT
  type        = string
  default     = "ENTERPRISE"

  validation {
    condition     = contains(["ENTERPRISE", "ENTERPRISE_PLUS"], var.db_edition)
    error_message = "db_edition must be ENTERPRISE or ENTERPRISE_PLUS."
  }
}

variable "db_tier" {
  description = <<-EOT
    Cloud SQL machine type. Must be valid for db_edition: shared-core
    (db-f1-micro, db-g1-small) and custom (db-custom-N-M) tiers are
    ENTERPRISE only; ENTERPRISE_PLUS takes db-perf-optimized-N-* instead.
  EOT
  type        = string
  default     = "db-f1-micro"
}

variable "db_disk_size_gb" {
  description = "Initial storage. Autoresize is on, so this is a floor."
  type        = number
  default     = 10
}

variable "db_availability_type" {
  description = "ZONAL (single zone) or REGIONAL (synchronous standby, ~2x cost)."
  type        = string
  default     = "ZONAL"
}

variable "db_backup_retention_days" {
  description = "Automated backup retention."
  type        = number
  default     = 7
}

variable "db_deletion_protection" {
  description = "Blocks `terraform destroy` from dropping the database."
  type        = bool
  default     = true
}

# ── Redis (Memorystore) ──────────────────────────────────────────────────────

variable "redis_enabled" {
  description = <<-EOT
    Required once the API runs more than one instance, so Socket.IO events reach
    every instance. Memorystore has no free tier and no scale-to-zero — the
    smallest instance costs roughly $35/month, which is usually the largest
    single line on a small deployment. Leave it off while api_max_instances is 1.
  EOT
  type        = bool
  default     = false
}

variable "redis_memory_size_gb" {
  description = "Memorystore capacity in GB (minimum 1)."
  type        = number
  default     = 1
}

# ── Email ────────────────────────────────────────────────────────────────────

variable "email_from" {
  description = "From address on outbound mail."
  type        = string
  default     = "Parentix <no-reply@parentix.ca>"
}

variable "admin_email" {
  description = <<-EOT
    Receives contact-form submissions and new-registration notices.

    These messages carry other people's personal data — a visitor's name, email
    and message; a new parent's name and email. A controlled role mailbox on the
    company domain is the right destination once real users are signing up: a
    personal consumer mailbox has no access controls, no retention policy, and
    no way to hand over.
  EOT
  type        = string
  default     = "merhawigu@gmail.com"
}

# ── Monitoring ───────────────────────────────────────────────────────────────

variable "alert_email" {
  description = <<-EOT
    Receives monitoring alerts: API unreachable, sustained 5xx responses, and
    Cloud SQL disk or CPU pressure. Empty disables alerting entirely.

    Nothing is created without this, deliberately — an alert policy with no
    notification channel shows up as coverage in the console and reaches
    nobody. The uptime check additionally needs `domain` to be set, since it
    probes a public hostname.
  EOT
  type        = string
  default     = ""
}

# ── Labels ───────────────────────────────────────────────────────────────────

variable "labels" {
  description = "Applied to every resource that supports labels, for billing breakdown."
  type        = map(string)
  default     = {}
}
