variable "namespace" {
  description = "Namespace for the gateway."
  type        = string
  default     = "switchyard"
}

variable "create_namespace" {
  description = "Create the namespace (false = it already exists)."
  type        = bool
  default     = true
}

variable "release_name" {
  description = "Helm release name."
  type        = string
  default     = "switchyard"
}

variable "chart_path" {
  description = "Path to the Switchyard Helm chart (deploy/helm/switchyard)."
  type        = string
}

variable "image" {
  description = "Container image (repository, tag, optional digest, pull policy)."
  type = object({
    repository  = string
    tag         = string
    digest      = optional(string, "")
    pull_policy = optional(string, "IfNotPresent")
  })
}

variable "gateway_config" {
  description = "gateway.yaml content as an object (chart value `config`). Secrets stay as $${ENV} placeholders."
  type        = any
}

variable "pricing" {
  description = "Optional pricing table (config/pricing.json format) shipped next to gateway.yaml."
  type        = any
  default     = null
}

variable "database_url" {
  description = "Postgres URL (DATABASE_URL)."
  type        = string
  sensitive   = true
}

variable "redis_url" {
  description = "Redis 8 URL (REDIS_URL)."
  type        = string
  sensitive   = true
}

variable "admin_token" {
  description = "Admin API token; generated when empty."
  type        = string
  default     = ""
  sensitive   = true
}

variable "extra_secret_env" {
  description = "Extra secret environment variables (provider API keys, opencode password, …)."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "api_replicas" {
  description = "API replicas (ignored when autoscaling is enabled)."
  type        = number
  default     = 2
}

variable "worker_replicas" {
  description = "Usage worker replicas."
  type        = number
  default     = 1
}

variable "autoscaling" {
  description = "API HorizontalPodAutoscaler settings."
  type = object({
    enabled     = optional(bool, false)
    min         = optional(number, 2)
    max         = optional(number, 10)
    cpu_percent = optional(number, 70)
  })
  default = {}
}

variable "service" {
  description = "API Service type and optional fixed nodePort."
  type = object({
    type      = optional(string, "ClusterIP")
    node_port = optional(number)
  })
  default = {}
}

variable "monitoring" {
  description = "Create ServiceMonitors / PrometheusRule (needs the Prometheus Operator CRDs)."
  type = object({
    service_monitor = optional(bool, false)
    prometheus_rule = optional(bool, false)
  })
  default = {}
}

variable "resources" {
  description = "Resource requests/limits for the api and worker containers."
  type = object({
    api = optional(object({
      requests = map(string)
      limits   = map(string)
    }), { requests = { cpu = "100m", memory = "128Mi" }, limits = { memory = "384Mi" } })
    worker = optional(object({
      requests = map(string)
      limits   = map(string)
    }), { requests = { cpu = "50m", memory = "96Mi" }, limits = { memory = "256Mi" } })
  })
  default = {}
}

variable "extra_values" {
  description = "Additional chart values (YAML strings), applied last."
  type        = list(string)
  default     = []
}
