# ──────────────────────────────────────────────────────────────────────────────────────────────
# EXAMPLE ONLY — validated with `terraform validate`, never applied by this project.
#
# Switchyard on Amazon EKS with the same modules as envs/local-kind: VPC + EKS (managed node
# group, EBS CSI driver via Pod Identity) → Redis/Postgres StatefulSets on gp3 → kube-prometheus-
# stack + dashboards → Switchyard chart from ghcr.io. For production, prefer RDS for PostgreSQL
# over the in-cluster StatefulSet and pass its URL to module.switchyard. Redis must be a single
# Redis 8 primary: the semantic cache uses vector sets, which ElastiCache/MemoryDB (Valkey,
# Redis OSS 7) do not provide — use Redis Cloud / Redis Software or keep the StatefulSet.
# ──────────────────────────────────────────────────────────────────────────────────────────────

provider "aws" {
  region = var.region
  default_tags {
    tags = var.tags
  }
}

data "aws_availability_zones" "available" {
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  azs       = slice(data.aws_availability_zones.available.names, 0, 3)
  repo_root = abspath("${path.module}/../../../..")
}

# ── network ──────────────────────────────────────────────────────────────────────────────────
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "6.7.3"

  name = var.name
  cidr = var.vpc_cidr
  azs  = local.azs

  private_subnets = [for i, _ in local.azs : cidrsubnet(var.vpc_cidr, 4, i)]
  public_subnets  = [for i, _ in local.azs : cidrsubnet(var.vpc_cidr, 8, 48 + i)]

  enable_nat_gateway = true
  single_nat_gateway = true

  public_subnet_tags  = { "kubernetes.io/role/elb" = 1 }
  private_subnet_tags = { "kubernetes.io/role/internal-elb" = 1 }
}

# ── EKS ──────────────────────────────────────────────────────────────────────────────────────
data "aws_iam_policy_document" "ebs_csi_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ebs_csi" {
  name               = "${var.name}-ebs-csi"
  assume_role_policy = data.aws_iam_policy_document.ebs_csi_trust.json
}

resource "aws_iam_role_policy_attachment" "ebs_csi" {
  role       = aws_iam_role.ebs_csi.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "21.29.0"

  name               = var.name
  kubernetes_version = var.kubernetes_version

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  endpoint_public_access                   = true
  enable_cluster_creator_admin_permissions = true

  addons = {
    coredns                = {}
    kube-proxy             = {}
    eks-pod-identity-agent = { before_compute = true }
    vpc-cni                = { before_compute = true }
    aws-ebs-csi-driver = {
      pod_identity_association = [{
        role_arn        = aws_iam_role.ebs_csi.arn
        service_account = "ebs-csi-controller-sa"
      }]
    }
  }

  eks_managed_node_groups = {
    default = {
      ami_type       = "AL2023_x86_64_STANDARD"
      instance_types = var.node_instance_types
      min_size       = var.node_count.min
      max_size       = var.node_count.max
      desired_size   = var.node_count.desired
    }
  }
}

provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name, "--region", var.region]
  }
}

provider "helm" {
  kubernetes = {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
    exec = {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name, "--region", var.region]
    }
  }
}

resource "kubernetes_storage_class_v1" "gp3" {
  metadata {
    name        = "gp3"
    annotations = { "storageclass.kubernetes.io/is-default-class" = "true" }
  }
  storage_provisioner    = "ebs.csi.aws.com"
  reclaim_policy         = "Retain"
  volume_binding_mode    = "WaitForFirstConsumer"
  allow_volume_expansion = true
  parameters = {
    type      = "gp3"
    encrypted = "true"
  }
  depends_on = [module.eks]
}

# ── workloads (same modules as local-kind) ──────────────────────────────────────────────────
resource "random_password" "postgres" {
  length  = 32
  special = false
}

resource "random_password" "grafana_reader" {
  length  = 32
  special = false
}

resource "random_password" "grafana_admin" {
  length  = 24
  special = false
}

resource "kubernetes_namespace_v1" "switchyard" {
  metadata {
    name = "switchyard"
    labels = {
      "pod-security.kubernetes.io/enforce" = "restricted"
    }
  }
  depends_on = [module.eks]
}

module "postgres" {
  source             = "../../modules/postgres"
  namespace          = kubernetes_namespace_v1.switchyard.metadata[0].name
  password           = random_password.postgres.result
  reader_password    = random_password.grafana_reader.result
  storage_size       = "20Gi"
  storage_class_name = kubernetes_storage_class_v1.gp3.metadata[0].name
  resources = {
    requests = { cpu = "250m", memory = "512Mi" }
    limits   = { memory = "1Gi" }
  }
  postgres_args = {
    shared_buffers  = "256MB"
    max_connections = "200"
  }
}

module "redis" {
  source             = "../../modules/redis"
  namespace          = kubernetes_namespace_v1.switchyard.metadata[0].name
  password           = var.redis_password
  maxmemory          = "768mb"
  storage_size       = "5Gi"
  storage_class_name = kubernetes_storage_class_v1.gp3.metadata[0].name
  resources = {
    requests = { cpu = "100m", memory = "512Mi" }
    limits   = { memory = "1Gi" }
  }
}

module "observability" {
  source = "../../modules/observability"

  dashboards_dir          = "${local.repo_root}/observability/grafana/dashboards"
  grafana_admin_password  = random_password.grafana_admin.result
  prometheus_retention    = "15d"
  prometheus_storage_size = "50Gi"
  small_footprint         = false
  postgres_datasource = {
    host     = module.postgres.host
    database = module.postgres.database
    user     = module.postgres.reader_username
    password = random_password.grafana_reader.result
  }
}

module "switchyard" {
  source = "../../modules/switchyard"

  namespace        = kubernetes_namespace_v1.switchyard.metadata[0].name
  create_namespace = false
  chart_path       = "${local.repo_root}/deploy/helm/switchyard"
  image            = { repository = "ghcr.io/riz1-k/switchyard", tag = var.image_tag }
  gateway_config   = yamldecode(file(var.gateway_config_file))
  database_url     = module.postgres.database_url
  redis_url        = module.redis.url
  extra_secret_env = var.provider_secrets
  autoscaling      = { enabled = true, min = 2, max = 10, cpu_percent = 70 }
  worker_replicas  = 2
  monitoring       = { service_monitor = true, prometheus_rule = true }
  resources = {
    api = {
      requests = { cpu = "250m", memory = "256Mi" }
      limits   = { memory = "768Mi" }
    }
  }
  extra_values = var.ingress_host == "" ? [] : [yamlencode({
    ingress = {
      enabled   = true
      className = "alb"
      annotations = {
        "alb.ingress.kubernetes.io/scheme"           = "internet-facing"
        "alb.ingress.kubernetes.io/target-type"      = "ip"
        "alb.ingress.kubernetes.io/listen-ports"     = "[{\"HTTPS\":443}]"
        "alb.ingress.kubernetes.io/certificate-arn"  = var.acm_certificate_arn
        "alb.ingress.kubernetes.io/healthcheck-path" = "/readyz"
      }
      hosts = [{ host = var.ingress_host, paths = [{ path = "/", pathType = "Prefix" }] }]
    }
  })]

  depends_on = [module.observability]
}
