variable "namespace" {
  description = "Namespace to deploy Redis into (must exist)."
  type        = string
}

variable "name" {
  description = "Name of the StatefulSet / Service."
  type        = string
  default     = "redis"
}

variable "image" {
  description = "Official Redis 8 image (vector sets are required by the semantic cache)."
  type        = string
  default     = "redis:8.8.4-alpine@sha256:be8dfdf58574d626e0abe03073ce9178509e0e9564a316e34e71d2289b8370e1"
}

variable "password" {
  description = "Password for the default user (empty = no auth; only for isolated dev clusters)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "maxmemory" {
  description = "Redis maxmemory. Switchyard keeps non-cache state in Redis, so the policy is noeviction."
  type        = string
  default     = "192mb"
}

variable "storage_size" {
  description = "PersistentVolumeClaim size (AOF)."
  type        = string
  default     = "1Gi"
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
    requests = { cpu = "50m", memory = "64Mi" }
    limits   = { memory = "256Mi" }
  }
}
