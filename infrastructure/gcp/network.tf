# Networking exists here only to reach Memorystore, which has no public
# endpoint. Cloud Run itself needs no VPC, and Cloud SQL is attached through the
# Cloud Run socket integration rather than over the network — so with
# redis_enabled = false none of this is created and there is nothing to pay for.

resource "google_compute_network" "vpc" {
  count = local.need_vpc ? 1 : 0

  name                    = "${local.prefix}-vpc"
  auto_create_subnetworks = false

  depends_on = [google_project_service.services]
}

resource "google_compute_subnetwork" "main" {
  count = local.need_vpc ? 1 : 0

  name          = "${local.prefix}-subnet"
  ip_cidr_range = "10.20.0.0/20"
  region        = var.region
  network       = google_compute_network.vpc[0].id

  # Flow logs are billed by volume; sampling keeps them useful without the cost
  # of capturing everything.
  log_config {
    aggregation_interval = "INTERVAL_10_MIN"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

# Serverless VPC Access: the bridge that lets a Cloud Run instance send packets
# into the VPC. Billed per instance-hour whether or not traffic flows.
resource "google_vpc_access_connector" "main" {
  count = local.need_vpc ? 1 : 0

  name          = "${local.prefix}-conn"
  region        = var.region
  network       = google_compute_network.vpc[0].name
  ip_cidr_range = "10.21.0.0/28"

  min_instances = 2
  max_instances = 3
  machine_type  = "e2-micro"

  depends_on = [google_project_service.services]
}

# Memorystore lives in a Google-managed network peered with this VPC. This
# reservation is the address range that peering is allowed to allocate from.
resource "google_compute_global_address" "private_service_range" {
  count = local.need_vpc ? 1 : 0

  name          = "${local.prefix}-psa"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vpc[0].id
}

resource "google_service_networking_connection" "private_vpc" {
  count = local.need_vpc ? 1 : 0

  network                 = google_compute_network.vpc[0].id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_service_range[0].name]

  depends_on = [google_project_service.services]
}
