# Memorystore for Redis — the ElastiCache replacement.
#
# Only needed once the API runs more than one Cloud Run instance: Socket.IO
# keeps its connection state in process, so without a shared adapter an event
# emitted on instance A never reaches a client connected to instance B.
#
# There is no scale-to-zero and no free tier here. On a small deployment this is
# usually the single largest line on the bill, which is why it is opt-in.

resource "google_redis_instance" "main" {
  count = var.redis_enabled ? 1 : 0

  name           = "${local.prefix}-redis"
  region         = var.region
  memory_size_gb = var.redis_memory_size_gb

  # BASIC is a single node with no replica: a failure loses the cache and drops
  # live sockets, but clients reconnect. STANDARD_HA doubles the cost for a
  # standby. For Socket.IO fan-out, BASIC is the right trade.
  tier = "BASIC"

  redis_version      = "REDIS_7_0"
  connect_mode       = "PRIVATE_SERVICE_ACCESS"
  authorized_network = google_compute_network.vpc[0].id

  # In-transit encryption would need the API to present a CA bundle; the
  # instance is only reachable from inside the peered VPC, so the exposure this
  # protects against does not exist here.
  auth_enabled = true

  labels = local.labels

  depends_on = [
    google_project_service.services,
    google_service_networking_connection.private_vpc,
  ]
}
