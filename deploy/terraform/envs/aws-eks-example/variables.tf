variable "region" {
  description = "AWS region."
  type        = string
  default     = "eu-central-1"
}

variable "name" {
  description = "Name prefix for the VPC and EKS cluster."
  type        = string
  default     = "switchyard"
}

variable "kubernetes_version" {
  description = "EKS Kubernetes version."
  type        = string
  default     = "1.35"
}

variable "vpc_cidr" {
  description = "VPC CIDR block."
  type        = string
  default     = "10.40.0.0/16"
}

variable "node_instance_types" {
  description = "Managed node group instance types."
  type        = list(string)
  default     = ["m7i.large"]
}

variable "node_count" {
  description = "Managed node group size."
  type = object({
    min     = number
    max     = number
    desired = number
  })
  default = { min = 2, max = 5, desired = 3 }
}

variable "image_tag" {
  description = "Tag of ghcr.io/riz1-k/switchyard to deploy."
  type        = string
  default     = "0.1.0"
}

variable "gateway_config_file" {
  description = "Path to the gateway.yaml to deploy (see config/gateway.example.yaml); secrets as $${ENV} placeholders."
  type        = string
}

variable "provider_secrets" {
  description = "Secret env vars referenced by the config, e.g. { OPENAI_API_KEY = \"…\", ANTHROPIC_API_KEY = \"…\" }."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "redis_password" {
  description = "Redis password."
  type        = string
  sensitive   = true
}

variable "ingress_host" {
  description = "Public host name for an ALB Ingress (requires the AWS Load Balancer Controller); empty = no Ingress."
  type        = string
  default     = ""
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN for the ALB HTTPS listener."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags applied to all AWS resources."
  type        = map(string)
  default     = { project = "switchyard", environment = "example" }
}
