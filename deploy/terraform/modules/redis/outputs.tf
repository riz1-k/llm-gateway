output "host" {
  description = "In-cluster DNS name of the Redis Service."
  value       = "${kubernetes_service_v1.this.metadata[0].name}.${var.namespace}.svc.cluster.local"
}

output "url" {
  description = "Redis URL for Switchyard (REDIS_URL), database 0."
  value = format("redis://%s%s.%s.svc.cluster.local:6379/0",
    local.auth ? ":${urlencode(var.password)}@" : "",
  kubernetes_service_v1.this.metadata[0].name, var.namespace)
  sensitive  = true
  depends_on = [kubernetes_stateful_set_v1.this]
}
