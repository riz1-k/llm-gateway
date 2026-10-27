output "gateway_url" {
  description = "Gateway URL on the host (NodePort 30787)."
  value       = "http://127.0.0.1:${var.gateway_host_port}"
}

output "grafana_url" {
  description = "Grafana URL on the host (NodePort 30300); user admin."
  value       = var.observability_enabled ? "http://127.0.0.1:${var.grafana_host_port}" : null
}

output "grafana_admin_password" {
  description = "Grafana admin password."
  value       = var.grafana_admin_password != "" ? var.grafana_admin_password : random_password.grafana_admin.result
  sensitive   = true
}

output "admin_token" {
  description = "Switchyard admin API token."
  value       = module.switchyard.admin_token
  sensitive   = true
}

output "kubeconfig_path" {
  description = "kubeconfig for the cluster (export KUBECONFIG=…)."
  value       = kind_cluster.this.kubeconfig_path
}
