output "namespace" {
  description = "Namespace of the monitoring stack."
  value       = kubernetes_namespace_v1.this.metadata[0].name
}

output "prometheus_url" {
  description = "In-cluster Prometheus URL."
  value       = "http://${var.release_name}-prometheus.${kubernetes_namespace_v1.this.metadata[0].name}.svc:9090"
  depends_on  = [helm_release.kube_prometheus_stack]
}

output "grafana_service" {
  description = "In-cluster Grafana Service name."
  value       = "${var.release_name}-grafana"
  depends_on  = [helm_release.kube_prometheus_stack]
}

output "dashboards" {
  description = "Dashboard ConfigMaps created for the Grafana sidecar."
  value       = [for cm in kubernetes_config_map_v1.dashboards : cm.metadata[0].name]
}
