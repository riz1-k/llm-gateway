# Local Kubernetes environment: a single-node kind cluster running Switchyard (api + worker +
# migration hook), Redis 8, Postgres 18, an in-cluster mock upstream, kube-prometheus-stack with
# the Switchyard dashboards, and a seed job for the demo teams.
#
#   make k8s-up     (terraform init + apply)      gateway http://127.0.0.1:8797
#   make k8s-demo   (demo traffic via NodePort)   grafana http://127.0.0.1:3301
#   make k8s-down   (terraform destroy)
#
# Uses config/gateway.compose.yaml (mock upstreams) and config/pricing.json from this checkout.

locals {
  repo_root = abspath("${path.module}/../../../..")
  image     = "${var.image_repository}:${var.image_tag}"
  namespace = "switchyard"

  # Rebuild/reload the image when the sources that go into it change.
  source_hash = sha256(join("", concat(
    [for f in sort(fileset(local.repo_root, "packages/*/src/**")) : filesha256("${local.repo_root}/${f}")],
    [for f in ["pnpm-lock.yaml", "deploy/docker/Dockerfile", "packages/gateway/package.json"] : filesha256("${local.repo_root}/${f}")],
  )))

  labels = {
    "app.kubernetes.io/part-of"    = "switchyard"
    "app.kubernetes.io/managed-by" = "terraform"
  }
}

# ── cluster ──────────────────────────────────────────────────────────────────────────────────
resource "kind_cluster" "this" {
  name            = var.cluster_name
  node_image      = var.node_image
  wait_for_ready  = true
  kubeconfig_path = abspath("${path.module}/.kubeconfig")

  kind_config {
    kind        = "Cluster"
    api_version = "kind.x-k8s.io/v1alpha4"

    node {
      role = "control-plane"
      extra_port_mappings {
        container_port = 30787 # switchyard Service (NodePort)
        host_port      = var.gateway_host_port
        listen_address = "127.0.0.1"
        protocol       = "TCP"
      }
      extra_port_mappings {
        container_port = 30300 # Grafana Service (NodePort)
        host_port      = var.grafana_host_port
        listen_address = "127.0.0.1"
        protocol       = "TCP"
      }
    }
  }
}

provider "kubernetes" {
  host                   = kind_cluster.this.endpoint
  client_certificate     = kind_cluster.this.client_certificate
  client_key             = kind_cluster.this.client_key
  cluster_ca_certificate = kind_cluster.this.cluster_ca_certificate
}

provider "helm" {
  kubernetes = {
    host                   = kind_cluster.this.endpoint
    client_certificate     = kind_cluster.this.client_certificate
    client_key             = kind_cluster.this.client_key
    cluster_ca_certificate = kind_cluster.this.cluster_ca_certificate
  }
}

# ── image: build from this checkout and side-load into the node ─────────────────────────────
resource "terraform_data" "image" {
  triggers_replace = [kind_cluster.this.id, local.image, var.build_image ? local.source_hash : "prebuilt"]

  provisioner "local-exec" {
    working_dir = local.repo_root
    interpreter = ["bash", "-c"]
    command     = <<-EOT
      set -euo pipefail
      if [ "${var.build_image}" = "true" ]; then
        docker build -f deploy/docker/Dockerfile -t '${local.image}' .
      fi
      kind load docker-image '${local.image}' --name '${kind_cluster.this.name}'
    EOT
  }
}

resource "terraform_data" "preload" {
  triggers_replace = [kind_cluster.this.id, var.preload_images]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-EOT
      for img in ${join(" ", [for i in var.preload_images : "'${i}'"])}; do
        if docker image inspect "$img" >/dev/null 2>&1; then
          kind load docker-image "$img" --name '${kind_cluster.this.name}' || echo "warning: could not preload $img (it will be pulled)"
        fi
      done
    EOT
  }
}

# ── credentials ──────────────────────────────────────────────────────────────────────────────
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

# ── data stores ──────────────────────────────────────────────────────────────────────────────
resource "kubernetes_namespace_v1" "switchyard" {
  metadata {
    name = local.namespace
    labels = merge(local.labels, {
      "pod-security.kubernetes.io/enforce" = "restricted"
      "pod-security.kubernetes.io/warn"    = "restricted"
    })
  }
  depends_on = [kind_cluster.this]
}

module "postgres" {
  source          = "../../modules/postgres"
  namespace       = kubernetes_namespace_v1.switchyard.metadata[0].name
  password        = random_password.postgres.result
  reader_password = random_password.grafana_reader.result
  storage_size    = "1Gi"
}

module "redis" {
  source       = "../../modules/redis"
  namespace    = kubernetes_namespace_v1.switchyard.metadata[0].name
  storage_size = "512Mi"
}

# ── in-cluster mock upstream (same image, `switchyard mock-provider`) ──────────────────────
resource "kubernetes_deployment_v1" "mock_provider" {
  metadata {
    name      = "mock-provider"
    namespace = kubernetes_namespace_v1.switchyard.metadata[0].name
    labels    = merge(local.labels, { "app.kubernetes.io/name" = "mock-provider" })
  }
  spec {
    replicas = 1
    selector {
      match_labels = { "app.kubernetes.io/name" = "mock-provider" }
    }
    template {
      metadata {
        labels = merge(local.labels, { "app.kubernetes.io/name" = "mock-provider" })
      }
      spec {
        automount_service_account_token = false
        security_context {
          run_as_non_root = true
          run_as_user     = 65532
          run_as_group    = 65532
          seccomp_profile {
            type = "RuntimeDefault"
          }
        }
        container {
          name              = "mock-provider"
          image             = local.image
          image_pull_policy = "Never"
          args              = ["mock-provider", "--host", "0.0.0.0", "--port", "8790"]
          port {
            name           = "http"
            container_port = 8790
          }
          readiness_probe {
            http_get {
              path = "/health"
              port = "http"
            }
            period_seconds = 5
          }
          resources {
            requests = { cpu = "20m", memory = "48Mi" }
            limits   = { memory = "128Mi" }
          }
          security_context {
            run_as_non_root            = true # explicit: the provider otherwise sends false
            allow_privilege_escalation = false
            read_only_root_filesystem  = true
            capabilities {
              drop = ["ALL"]
            }
          }
        }
      }
    }
  }
  depends_on = [terraform_data.image]
}

resource "kubernetes_service_v1" "mock_provider" {
  metadata {
    name      = "mock-provider"
    namespace = kubernetes_namespace_v1.switchyard.metadata[0].name
    labels    = local.labels
  }
  spec {
    selector = { "app.kubernetes.io/name" = "mock-provider" }
    port {
      name        = "http"
      port        = 8790
      target_port = "http"
    }
  }
}

# ── metrics-server (kind ships none; enables `kubectl top` and CPU-based HPAs) ───────────────
resource "helm_release" "metrics_server" {
  count = var.metrics_server_enabled ? 1 : 0

  name       = "metrics-server"
  namespace  = "kube-system"
  repository = "https://kubernetes-sigs.github.io/metrics-server/"
  chart      = "metrics-server"
  version    = "3.14.0"
  atomic     = true
  timeout    = 300

  values = [yamlencode({
    # kind kubelets serve self-signed certificates.
    args      = ["--kubelet-insecure-tls", "--metric-resolution=30s"]
    resources = { requests = { cpu = "20m", memory = "48Mi" }, limits = { memory = "96Mi" } }
  })]

  depends_on = [kind_cluster.this]
}

# ── observability ────────────────────────────────────────────────────────────────────────────
module "observability" {
  source = "../../modules/observability"
  count  = var.observability_enabled ? 1 : 0

  dashboards_dir         = "${local.repo_root}/observability/grafana/dashboards"
  grafana_admin_password = var.grafana_admin_password != "" ? var.grafana_admin_password : random_password.grafana_admin.result
  grafana_service        = { type = "NodePort", node_port = 30300 }
  postgres_datasource = {
    host     = module.postgres.host
    database = module.postgres.database
    user     = module.postgres.reader_username
    password = random_password.grafana_reader.result
  }
  small_footprint = true

  depends_on = [terraform_data.preload]
}

# ── Switchyard ───────────────────────────────────────────────────────────────────────────────
module "switchyard" {
  source = "../../modules/switchyard"

  namespace        = kubernetes_namespace_v1.switchyard.metadata[0].name
  create_namespace = false
  chart_path       = "${local.repo_root}/deploy/helm/switchyard"
  image            = { repository = var.image_repository, tag = var.image_tag, pull_policy = "Never" }
  gateway_config   = yamldecode(file("${local.repo_root}/config/gateway.compose.yaml"))
  pricing          = jsondecode(file("${local.repo_root}/config/pricing.json"))
  database_url     = module.postgres.database_url
  redis_url        = module.redis.url
  admin_token      = var.admin_token
  api_replicas     = 2
  worker_replicas  = 1
  service          = { type = "NodePort", node_port = 30787 }
  monitoring = {
    service_monitor = var.observability_enabled
    prometheus_rule = var.observability_enabled
  }

  depends_on = [terraform_data.image, kubernetes_service_v1.mock_provider, module.observability]
}

# ── demo seed: teams docsqa/opsagent/evals with monthly budgets (idempotent) ────────────────
resource "kubernetes_job_v1" "seed" {
  metadata {
    name      = "switchyard-seed"
    namespace = kubernetes_namespace_v1.switchyard.metadata[0].name
    labels    = merge(local.labels, { "app.kubernetes.io/component" = "seed" })
  }
  spec {
    backoff_limit = 4
    template {
      metadata {
        labels = merge(local.labels, { "app.kubernetes.io/component" = "seed" })
      }
      spec {
        restart_policy                  = "Never"
        automount_service_account_token = false
        security_context {
          run_as_non_root = true
          run_as_user     = 65532
          run_as_group    = 65532
          seccomp_profile {
            type = "RuntimeDefault"
          }
        }
        container {
          name              = "seed"
          image             = local.image
          image_pull_policy = "Never"
          # Keys go to a throwaway file (never to logs); the demo issues its own via the admin API.
          args = ["seed-dev", "--output", "/tmp/seed-keys.env"]
          env_from {
            secret_ref {
              name = module.switchyard.secret_name
            }
          }
          volume_mount {
            name       = "config"
            mount_path = "/etc/switchyard"
            read_only  = true
          }
          volume_mount {
            name       = "tmp"
            mount_path = "/tmp"
          }
          resources {
            requests = { cpu = "20m", memory = "64Mi" }
            limits   = { memory = "192Mi" }
          }
          security_context {
            run_as_non_root            = true # explicit: the provider otherwise sends false
            allow_privilege_escalation = false
            read_only_root_filesystem  = true
            capabilities {
              drop = ["ALL"]
            }
          }
        }
        volume {
          name = "config"
          config_map {
            name = module.switchyard.config_map_name
          }
        }
        volume {
          name = "tmp"
          empty_dir {}
        }
      }
    }
  }
  wait_for_completion = true
  timeouts {
    create = "5m"
  }
}
