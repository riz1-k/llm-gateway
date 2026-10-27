output "namespace" {
  description = "Namespace of the gateway."
  value       = local.namespace
}

output "service_name" {
  description = "API Service name (port 8787)."
  value       = local.fullname
  depends_on  = [helm_release.this]
}

output "config_map_name" {
  description = "ConfigMap with gateway.yaml (mount it for one-off jobs such as seeding)."
  value       = local.fullname
  depends_on  = [helm_release.this]
}

output "secret_name" {
  description = "Secret with SWITCHYARD_ADMIN_TOKEN, DATABASE_URL and REDIS_URL."
  value       = kubernetes_secret_v1.this.metadata[0].name
}

output "admin_token" {
  description = "Admin API token."
  value       = local.admin_token
  sensitive   = true
}

output "release" {
  description = "Helm release name and revision."
  value       = { name = helm_release.this.name, revision = helm_release.this.metadata.revision }
}
