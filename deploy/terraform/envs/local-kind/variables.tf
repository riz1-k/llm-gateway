variable "cluster_name" {
  description = "kind cluster name."
  type        = string
  default     = "switchyard"
}

variable "node_image" {
  description = "kind node image (Kubernetes version), pinned by digest (kind v0.33 defaults)."
  type        = string
  default     = "kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5"
}

variable "image_repository" {
  description = "Switchyard image repository loaded into the cluster."
  type        = string
  default     = "switchyard"
}

variable "image_tag" {
  description = "Switchyard image tag."
  type        = string
  default     = "dev"
}

variable "build_image" {
  description = "Build the image from this checkout before loading it (false = use an existing local image)."
  type        = bool
  default     = true
}

variable "preload_images" {
  description = "Images already present in the local Docker daemon to side-load into the node (best effort, saves pulls; kind stages each as a tar in $TMPDIR, e.g. [\"docker.io/grafana/grafana:13.2.4\"])."
  type        = list(string)
  default     = []
}

variable "gateway_host_port" {
  description = "Host port (127.0.0.1) mapped to the gateway NodePort 30787."
  type        = number
  default     = 8797
}

variable "grafana_host_port" {
  description = "Host port (127.0.0.1) mapped to the Grafana NodePort 30300."
  type        = number
  default     = 3301
}

variable "metrics_server_enabled" {
  description = "Install metrics-server (kubectl top, CPU-based HPA)."
  type        = bool
  default     = true
}

variable "observability_enabled" {
  description = "Install kube-prometheus-stack + dashboards (disable on machines with < 3 GB free RAM)."
  type        = bool
  default     = true
}

variable "grafana_admin_password" {
  description = "Grafana admin password (generated when empty)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "admin_token" {
  description = "Switchyard admin token (generated when empty)."
  type        = string
  default     = ""
  sensitive   = true
}
