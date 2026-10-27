# Prometheus Operator + Prometheus + Grafana via kube-prometheus-stack, tuned for small clusters,
# plus the Switchyard dashboards (ConfigMaps picked up by the Grafana sidecar) and a read-only
# Postgres datasource for the cost panels.

locals {
  labels = {
    "app.kubernetes.io/part-of"    = "switchyard"
    "app.kubernetes.io/managed-by" = "terraform"
  }
  dashboards = fileset(var.dashboards_dir, "*.json")
  pg         = var.postgres_datasource

  small = {
    alertmanager               = { enabled = false }
    nodeExporter               = { enabled = false }
    "prometheus-node-exporter" = { enabled = false }
    kubeEtcd                   = { enabled = false }
    kubeControllerManager      = { enabled = false }
    kubeScheduler              = { enabled = false }
    kubeProxy                  = { enabled = false }
    coreDns                    = { enabled = false }
    # Keep only a handful of the default rule groups (k8s health), drop the rest.
    defaultRules = {
      create = true
      rules = {
        alertmanager                      = false
        etcd                              = false
        configReloaders                   = false
        general                           = true
        k8sContainerCpuUsageSecondsTotal  = true
        k8sContainerMemoryWorkingSetBytes = true
        k8sPodOwner                       = true
        kubeApiserverAvailability         = false
        kubeApiserverBurnrate             = false
        kubeApiserverHistogram            = false
        kubeApiserverSlos                 = false
        kubeControllerManager             = false
        kubelet                           = true
        kubeProxy                         = false
        kubePrometheusGeneral             = true
        kubePrometheusNodeRecording       = false
        kubernetesApps                    = true
        kubernetesResources               = true
        kubernetesStorage                 = true
        kubernetesSystem                  = false
        kubeSchedulerAlerting             = false
        kubeSchedulerRecording            = false
        kubeStateMetrics                  = true
        network                           = false
        node                              = false
        nodeExporterAlerting              = false
        nodeExporterRecording             = false
        prometheus                        = true
        prometheusOperator                = true
        windows                           = false
      }
    }
    prometheusOperator = {
      # The admission webhook needs cert jobs + extra images; not worth it on a dev cluster.
      admissionWebhooks = { enabled = false }
      tls               = { enabled = false }
      resources = {
        requests = { cpu = "20m", memory = "48Mi" }
        limits   = { memory = "128Mi" }
      }
      prometheusConfigReloader = {
        resources = {
          requests = { cpu = "5m", memory = "16Mi" }
          limits   = { memory = "48Mi" }
        }
      }
    }
    kube-state-metrics = {
      resources = {
        requests = { cpu = "10m", memory = "32Mi" }
        limits   = { memory = "96Mi" }
      }
    }
  }

  base = {
    fullnameOverride = var.release_name
    # Select every ServiceMonitor / PrometheusRule in the cluster, not only this release's.
    prometheus = {
      prometheusSpec = {
        serviceMonitorSelectorNilUsesHelmValues = false
        podMonitorSelectorNilUsesHelmValues     = false
        ruleSelectorNilUsesHelmValues           = false
        probeSelectorNilUsesHelmValues          = false
        scrapeInterval                          = "15s"
        evaluationInterval                      = "15s"
        retention                               = var.prometheus_retention
        resources = {
          requests = { cpu = "50m", memory = "192Mi" }
          limits   = { memory = "512Mi" }
        }
        storageSpec = var.prometheus_storage_size == "" ? {} : {
          volumeClaimTemplate = {
            spec = {
              accessModes = ["ReadWriteOnce"]
              resources   = { requests = { storage = var.prometheus_storage_size } }
            }
          }
        }
      }
    }
    grafana = {
      adminPassword            = var.grafana_admin_password
      defaultDashboardsEnabled = !var.small_footprint
      "grafana.ini" = {
        analytics = { reporting_enabled = false, check_for_updates = false, check_for_plugin_updates = false }
        news      = { news_feed_enabled = false }
        users     = { allow_sign_up = false }
        dashboards = {
          default_home_dashboard_path = "/tmp/dashboards/Switchyard/switchyard-overview.json"
        }
      }
      envFromSecret = local.pg == null ? "" : kubernetes_secret_v1.grafana_env[0].metadata[0].name
      service = merge(
        { type = var.grafana_service.type },
        var.grafana_service.node_port == null ? {} : { nodePort = var.grafana_service.node_port }
      )
      resources = {
        requests = { cpu = "50m", memory = "128Mi" }
        limits   = { memory = "384Mi" }
      }
      sidecar = {
        resources = {
          requests = { cpu = "5m", memory = "48Mi" }
          limits   = { memory = "128Mi" }
        }
        dashboards = {
          enabled          = true
          label            = "grafana_dashboard"
          labelValue       = "1"
          searchNamespace  = "ALL"
          folderAnnotation = "grafana_folder"
          provider         = { foldersFromFilesStructure = true, allowUiUpdates = false }
        }
        datasources = {
          enabled      = true
          alertmanager = { enabled = !var.small_footprint }
        }
      }
      additionalDataSources = local.pg == null ? [] : [{
        name     = "Switchyard Postgres"
        uid      = "switchyard-postgres"
        type     = "grafana-postgresql-datasource"
        access   = "proxy"
        url      = "${local.pg.host}:${local.pg.port}"
        user     = local.pg.user
        editable = false
        jsonData = {
          database        = local.pg.database
          sslmode         = local.pg.sslmode
          postgresVersion = 1800
          timescaledb     = false
          maxOpenConns    = 5
        }
        # Resolved by Grafana from the environment (envFromSecret), so the password never lands
        # in the Helm release values.
        secureJsonData = { password = "$GRAFANA_PG_PASSWORD" }
      }]
    }
  }
}

resource "kubernetes_namespace_v1" "this" {
  metadata {
    name   = var.namespace
    labels = local.labels
  }
}

resource "kubernetes_secret_v1" "grafana_env" {
  count = local.pg == null ? 0 : 1
  metadata {
    name      = "${var.release_name}-grafana-env"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
    labels    = local.labels
  }
  data = {
    GRAFANA_PG_PASSWORD = local.pg.password
  }
}

resource "kubernetes_config_map_v1" "dashboards" {
  for_each = local.dashboards
  metadata {
    name      = "switchyard-dashboard-${trimsuffix(each.value, ".json")}"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
    labels    = merge(local.labels, { grafana_dashboard = "1" })
    annotations = {
      grafana_folder = "Switchyard"
    }
  }
  data = {
    (each.value) = file("${var.dashboards_dir}/${each.value}")
  }
}

resource "helm_release" "kube_prometheus_stack" {
  name             = var.release_name
  namespace        = kubernetes_namespace_v1.this.metadata[0].name
  repository       = "oci://ghcr.io/prometheus-community/charts"
  chart            = "kube-prometheus-stack"
  version          = var.chart_version
  create_namespace = false
  atomic           = true
  wait             = true
  timeout          = 900

  values = concat(
    [yamlencode(local.base)],
    var.small_footprint ? [yamlencode(local.small)] : [],
    var.extra_values,
  )
}
