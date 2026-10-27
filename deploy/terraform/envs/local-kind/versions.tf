terraform {
  required_version = ">= 1.9"
  required_providers {
    kind = {
      source  = "tehcyx/kind"
      version = "~> 0.13.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.4"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.3"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }
}
