# Single-instance Postgres (official image) as a StatefulSet with a PVC. Fine for dev/demo
# clusters; production should use a managed service (RDS, Cloud SQL, …) or an operator.

locals {
  labels = {
    "app.kubernetes.io/name"       = "postgres"
    "app.kubernetes.io/instance"   = var.name
    "app.kubernetes.io/part-of"    = "switchyard"
    "app.kubernetes.io/managed-by" = "terraform"
  }
  selector = {
    "app.kubernetes.io/name"     = "postgres"
    "app.kubernetes.io/instance" = var.name
  }
  reader_enabled = var.reader_username != ""
}

resource "kubernetes_secret_v1" "this" {
  metadata {
    name      = "${var.name}-credentials"
    namespace = var.namespace
    labels    = local.labels
  }
  data = merge(
    {
      POSTGRES_USER     = var.username
      POSTGRES_PASSWORD = var.password
      POSTGRES_DB       = var.database
    },
    local.reader_enabled ? {
      READER_USER     = var.reader_username
      READER_PASSWORD = var.reader_password
    } : {}
  )
}

resource "kubernetes_config_map_v1" "initdb" {
  metadata {
    name      = "${var.name}-initdb"
    namespace = var.namespace
    labels    = local.labels
  }
  data = {
    # Runs once on an empty data directory. pg_read_all_data also covers tables and monthly
    # usage_events partitions created later by `switchyard migrate` / the worker.
    "10-reader.sh" = <<-EOT
      #!/usr/bin/env bash
      set -euo pipefail
      [ -n "$${READER_USER:-}" ] || exit 0
      psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
        -v role="$READER_USER" -v pw="$READER_PASSWORD" <<'SQL'
      CREATE ROLE :"role" LOGIN PASSWORD :'pw' CONNECTION LIMIT 10;
      GRANT pg_read_all_data TO :"role";
      ALTER ROLE :"role" SET default_transaction_read_only = on;
      ALTER ROLE :"role" SET statement_timeout = '30s';
      SQL
    EOT
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
      name        = "postgres"
      port        = 5432
      target_port = "postgres"
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
        annotations = {
          "checksum/initdb" = sha256(jsonencode(kubernetes_config_map_v1.initdb.data))
        }
      }
      spec {
        automount_service_account_token = false
        security_context {
          run_as_user     = 70 # postgres user of the alpine image
          run_as_group    = 70
          fs_group        = 70
          run_as_non_root = true
          seccomp_profile {
            type = "RuntimeDefault"
          }
        }
        container {
          name  = "postgres"
          image = var.image
          args  = flatten([for k, v in var.postgres_args : ["-c", "${k}=${v}"]])
          port {
            name           = "postgres"
            container_port = 5432
          }
          env_from {
            secret_ref {
              name = kubernetes_secret_v1.this.metadata[0].name
            }
          }
          resources {
            requests = var.resources.requests
            limits   = var.resources.limits
          }
          readiness_probe {
            exec {
              command = ["sh", "-c", "pg_isready -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -h 127.0.0.1"]
            }
            period_seconds    = 5
            timeout_seconds   = 3
            failure_threshold = 6
          }
          liveness_probe {
            exec {
              command = ["sh", "-c", "pg_isready -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -h 127.0.0.1"]
            }
            initial_delay_seconds = 20
            period_seconds        = 10
            timeout_seconds       = 3
            failure_threshold     = 6
          }
          security_context {
            run_as_non_root            = true # explicit: the provider otherwise sends false
            allow_privilege_escalation = false
            capabilities {
              drop = ["ALL"]
            }
          }
          volume_mount {
            name       = "data"
            mount_path = "/var/lib/postgresql"
          }
          volume_mount {
            name       = "initdb"
            mount_path = "/docker-entrypoint-initdb.d"
            read_only  = true
          }
          volume_mount {
            name       = "run"
            mount_path = "/var/run/postgresql"
          }
        }
        volume {
          name = "initdb"
          config_map {
            name         = kubernetes_config_map_v1.initdb.metadata[0].name
            default_mode = "0555"
          }
        }
        volume {
          name = "run"
          empty_dir {}
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
