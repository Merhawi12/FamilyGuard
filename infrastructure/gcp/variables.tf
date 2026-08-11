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
    web apps on their *.web.app Firebase Hosting URLs, with no load balancer and
    no managed certificate. Useful for a first smoke test, not for production —
    and note the child app pins an https:// API hostname, so it needs a real
    domain.

    This load balancer fronts the API alone. The web apps are served by Firebase
    Hosting, which issues its own certificates and holds its own addresses, so
    only api.<domain> points here.
  EOT
  type        = string
  default     = ""
}

variable "app_subdomain" {
  description = "Family app hostname prefix. Served by Firebase Hosting, not by this load balancer."
  type        = string
  default     = "app"
}

variable "admin_subdomain" {
  description = "Admin dashboard hostname prefix. Served by Firebase Hosting, not by this load balancer."
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
    Create a Cloud DNS managed zone and the A record for the API load balancer.
    Set false if the domain's nameservers stay with your current registrar — you
    then create the record by hand, pointing at the load_balancer_ip output.

    Even when this is true, the web hostnames are not managed here: Firebase
    Hosting mints a fresh pair of A records per custom domain when the domain is
    connected, and they are not derivable from this configuration. Take them
    from the Firebase console and add them alongside.
  EOT
  type        = bool
  default     = false
}

# ── Sign in with Google ──────────────────────────────────────────────────────

variable "google_client_id" {
  description = <<-EOT
    OAuth Web client ID for Sign in with Google, from the Google Cloud console
    under APIs & Services → Credentials.

    Not a secret, which is why it is here rather than in Secret Manager: it ships
    inside the browser bundle and is sent to Google in the clear. It is still
    load-bearing — it is the audience an incoming Google ID token is checked
    against, and an empty value disables the feature outright rather than
    accepting a token minted for somebody else's application.

    The console's "Authorised JavaScript origins" must list every hostname that
    serves the Family App, including the *.web.app one.

    Empty leaves the Google button unrendered and POST /api/auth/google
    answering 503.
  EOT
  type        = string
  default     = ""
}

variable "google_extra_client_ids" {
  description = <<-EOT
    Further audiences to accept, beyond google_client_id. The packaged Android
    app authenticates with its own OAuth client, whose ID tokens carry a
    different `aud`, so that client ID belongs here.
  EOT
  type        = list(string)
  default     = []
}

# ── Firebase Hosting ─────────────────────────────────────────────────────────

variable "firebase_family_site" {
  description = <<-EOT
    Firebase Hosting site ID serving the Family App. Its default
    https://<site>.web.app URL never goes away, and stays the way to reach a
    release before the custom domain is pointed at it — so it is added to the
    API's CORS allowlist rather than only the custom hostnames.

    The sites themselves are created with the Firebase CLI (`firebase
    hosting:sites:create`), not here: Hosting is not modelled by the stable
    Google provider, and splitting one resource across two tools is how a
    deployment ends up with two of it.
  EOT
  type        = string
  default     = ""
}

variable "firebase_admin_site" {
  description = "Firebase Hosting site ID serving the Admin Dashboard. See firebase_family_site."
  type        = string
  default     = ""
}

variable "extra_cors_origins" {
  description = <<-EOT
    Additional browser origins the API accepts, on top of the web hostnames this
    configuration already derives. For a staging preview or a Firebase Hosting
    preview channel URL, which is minted per pull request and cannot be derived.
  EOT
  type        = list(string)
  default     = []
}

variable "client_link_origin" {
  description = <<-EOT
    Origin the API builds links against, when it should not simply be the first
    of the Family App's hostnames.

    The API reads `CLIENT_URL`'s first entry as more than a CORS allowance: it is
    the origin it writes into the password-reset email, and the one it hands
    Stripe as the success, cancel and billing-portal return URL. Four places
    where a hostname that does not resolve is not a cosmetic problem — the reset
    link goes nowhere, and a parent who has just paid is redirected to nothing.

    Normally leave this empty and app.<domain> leads, which is the intent: it is
    the app's canonical home. Set it when that hostname is not yet usable — an
    apex that already serves the same Firebase site is a fine substitute, since
    the app is one deployment answering on several names.

    Whatever is named here is prepended to the origin list and deduplicated, so
    setting it to a hostname already in the list only promotes it. It does not
    have to be a name the list would otherwise contain, but it does have to be
    one the Family App actually answers on, or every link is broken differently.
  EOT
  type        = string
  default     = ""
}

variable "retained_ssl_certificate" {
  description = <<-EOT
    Name of an existing managed certificate to keep attached to the HTTPS proxy
    alongside the one this configuration manages. Empty in steady state.

    This exists for one job: replacing the certificate without dropping TLS on
    api.<domain>. A Google-managed certificate sits in PROVISIONING for anywhere
    from fifteen minutes to several hours after it is created, and a proxy
    holding only that certificate serves nothing over HTTPS in the meantime. So
    when the domain list changes — as it does when the web hostnames move to
    Firebase Hosting and the certificate shrinks to the API alone — set this to
    the outgoing certificate's name for one apply, wait for the new one to read
    ACTIVE, then clear it and apply again. Both are attached in between and the
    proxy serves from whichever matches the SNI.
  EOT
  type        = string
  default     = ""
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
