variable "namespace" {
  description = "Namespace for Prometheus/Grafana (created by this module)."
  type        = string
  default     = "monitoring"
}

variable "release_name" {
  description = "Helm release name of kube-prometheus-stack."
  type        = string
  default     = "kps"
}

variable "chart_version" {
  description = "kube-prometheus-stack chart version."
  type        = string
  default     = "92.14.0"
}

variable "dashboards_dir" {
  description = "Directory with the Grafana dashboard JSON files (observability/grafana/dashboards)."
  type        = string
}

variable "grafana_admin_password" {
  description = "Grafana admin password."
  type        = string
  sensitive   = true
}

variable "grafana_service" {
  description = "Grafana Service type and optional fixed nodePort (for kind port mappings)."
  type = object({
    type      = optional(string, "ClusterIP")
    node_port = optional(number)
  })
  default = {}
}

variable "postgres_datasource" {
  description = "Read-only Postgres datasource for the cost dashboards (null disables it)."
  type = object({
    host     = string
    port     = optional(number, 5432)
    database = string
    user     = string
    password = string
    sslmode  = optional(string, "disable")
  })
  default   = null
  sensitive = true
}

variable "prometheus_retention" {
  description = "Prometheus TSDB retention."
  type        = string
  default     = "2d"
}

variable "prometheus_storage_size" {
  description = "Prometheus PVC size (empty = emptyDir)."
  type        = string
  default     = ""
}

variable "small_footprint" {
  description = "Disable Alertmanager, node-exporter and the default rule/dashboard sets and use tiny resource requests (dev/kind)."
  type        = bool
  default     = true
}

variable "extra_values" {
  description = "Additional kube-prometheus-stack values (YAML strings), applied last."
  type        = list(string)
  default     = []
}
