variable "namespace" {
  description = "Namespace to deploy Postgres into (must exist)."
  type        = string
}

variable "name" {
  description = "Name of the StatefulSet / Service."
  type        = string
  default     = "postgres"
}

variable "image" {
  description = "Official Postgres image (tag@digest recommended)."
  type        = string
  default     = "postgres:18.6-alpine@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5"
}

variable "database" {
  description = "Database created on first start."
  type        = string
  default     = "llmgateway"
}

variable "username" {
  description = "Owner role of the database (used by Switchyard)."
  type        = string
  default     = "switchyard"
}

variable "password" {
  description = "Password of the owner role."
  type        = string
  sensitive   = true
}

variable "reader_username" {
  description = "Read-only role for dashboards (Grafana Postgres datasource). Empty disables it."
  type        = string
  default     = "grafana_reader"
}

variable "reader_password" {
  description = "Password of the read-only role (required when reader_username is set)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "storage_size" {
  description = "PersistentVolumeClaim size."
  type        = string
  default     = "2Gi"
}

variable "storage_class_name" {
  description = "StorageClass for the PVC (null = cluster default)."
  type        = string
  default     = null
}

variable "resources" {
  description = "Container resource requests/limits."
  type = object({
    requests = map(string)
    limits   = map(string)
  })
  default = {
    requests = { cpu = "100m", memory = "128Mi" }
    limits   = { memory = "384Mi" }
  }
}

variable "postgres_args" {
  description = "Extra server settings passed as `-c key=value`."
  type        = map(string)
  default = {
    shared_buffers             = "64MB"
    max_connections            = "60"
    log_min_duration_statement = "1000"
  }
}
