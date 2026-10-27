output "cluster_name" {
  description = "EKS cluster name (aws eks update-kubeconfig --name …)."
  value       = module.eks.cluster_name
}

output "switchyard_service" {
  description = "In-cluster gateway Service."
  value       = "${module.switchyard.service_name}.${module.switchyard.namespace}.svc:8787"
}

output "admin_token" {
  description = "Switchyard admin API token."
  value       = module.switchyard.admin_token
  sensitive   = true
}

output "grafana_admin_password" {
  description = "Grafana admin password."
  value       = random_password.grafana_admin.result
  sensitive   = true
}
