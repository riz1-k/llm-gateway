# Single Redis 8 primary (official image) with AOF persistence on a PVC. Switchyard needs a
# single primary (multi-key Lua; Redis Cluster is not supported) and Redis ≥ 8 (vector sets).

locals {
  labels = {
    "app.kubernetes.io/name"       = "redis"
    "app.kubernetes.io/instance"   = var.name
    "app.kubernetes.io/part-of"    = "switchyard"
    "app.kubernetes.io/managed-by" = "terraform"
  }
  selector = {
    "app.kubernetes.io/name"     = "redis"
    "app.kubernetes.io/instance" = var.name
  }
  auth = var.password != ""
}

resource "kubernetes_secret_v1" "this" {
  count = local.auth ? 1 : 0
  metadata {
    name      = "${var.name}-credentials"
    namespace = var.namespace
    labels    = local.labels
  }
  data = {
    REDIS_PASSWORD = var.password
  }
}

resource "kubernetes_service_v1" "this" {
  metadata {
    name      = var.name
    namespace = var.namespace
    labels    = local.labels
  }
  spec {
    selector = local.selector
    port {
      name        = "redis"
      port        = 6379
      target_port = "redis"
    }
  }
}

resource "kubernetes_stateful_set_v1" "this" {
  metadata {
    name      = var.name
    namespace = var.namespace
    labels    = local.labels
  }
  spec {
    service_name = kubernetes_service_v1.this.metadata[0].name
    replicas     = 1
    selector {
      match_labels = local.selector
    }
    template {
      metadata {
        labels = local.labels
      }
      spec {
        automount_service_account_token = false
        security_context {
          run_as_user     = 999 # redis user of the official image
          run_as_group    = 1000
          fs_group        = 1000
          run_as_non_root = true
          seccomp_profile {
            type = "RuntimeDefault"
          }
        }
        container {
          name  = "redis"
          image = var.image
          command = concat(
            ["redis-server", "--appendonly", "yes", "--save", "", "--maxmemory", var.maxmemory,
            "--maxmemory-policy", "noeviction", "--dir", "/data"],
            local.auth ? ["--requirepass", "$(REDIS_PASSWORD)"] : []
          )
          port {
            name           = "redis"
            container_port = 6379
          }
          dynamic "env" {
            for_each = local.auth ? [1] : []
            content {
              name = "REDIS_PASSWORD"
              value_from {
                secret_key_ref {
                  name = kubernetes_secret_v1.this[0].metadata[0].name
                  key  = "REDIS_PASSWORD"
                }
              }
            }
          }
          resources {
            requests = var.resources.requests
            limits   = var.resources.limits
          }
          readiness_probe {
            exec {
              command = ["sh", "-c", local.auth ? "redis-cli -a \"$REDIS_PASSWORD\" --no-auth-warning ping" : "redis-cli ping"]
            }
            period_seconds  = 5
            timeout_seconds = 3
          }
          liveness_probe {
            tcp_socket {
              port = "redis"
            }
            initial_delay_seconds = 10
            period_seconds        = 10
          }
          security_context {
            run_as_non_root            = true # explicit: the provider otherwise sends false
            allow_privilege_escalation = false
            read_only_root_filesystem  = true
            capabilities {
              drop = ["ALL"]
            }
          }
          volume_mount {
            name       = "data"
            mount_path = "/data"
          }
        }
      }
    }
    volume_claim_template {
      metadata {
        name   = "data"
        labels = local.labels
      }
      spec {
        access_modes       = ["ReadWriteOnce"]
        storage_class_name = var.storage_class_name
        resources {
          requests = {
            storage = var.storage_size
          }
        }
      }
    }
    persistent_volume_claim_retention_policy {
      when_deleted = "Delete"
      when_scaled  = "Retain"
    }
  }
  wait_for_rollout = true
}
