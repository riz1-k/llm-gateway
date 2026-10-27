output "host" {
  description = "In-cluster DNS name of the Postgres Service."
  value       = "${kubernetes_service_v1.this.metadata[0].name}.${var.namespace}.svc.cluster.local"
}

output "port" {
  description = "Postgres port."
  value       = 5432
}

output "database" {
  description = "Database name."
  value       = var.database
}

output "database_url" {
  description = "Connection URL for the owner role (Switchyard DATABASE_URL)."
  value       = "postgres://${var.username}:${urlencode(var.password)}@${kubernetes_service_v1.this.metadata[0].name}.${var.namespace}.svc.cluster.local:5432/${var.database}"
  sensitive   = true
  depends_on  = [kubernetes_stateful_set_v1.this]
}

output "reader_username" {
  description = "Read-only role for dashboards."
  value       = var.reader_username
}
