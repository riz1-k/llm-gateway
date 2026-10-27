# Switchyard on Kubernetes: namespace, connection secrets and the local Helm chart.
# Secrets are created here (not passed as chart values) so they never end up in the Helm
# release history; the chart consumes them through `secrets.existingSecret`.

locals {
  namespace = var.create_namespace ? kubernetes_namespace_v1.this[0].metadata[0].name : var.namespace
  labels = {
    "app.kubernetes.io/part-of"    = "switchyard"
    "app.kubernetes.io/managed-by" = "terraform"
  }
  # Mirrors the chart's "switchyard.fullname" helper.
  fullname = strcontains(var.release_name, "switchyard") ? var.release_name : "${var.release_name}-switchyard"
  chart_hash = substr(sha256(join("", [
    for f in sort(fileset(var.chart_path, "**")) : filesha256("${var.chart_path}/${f}")
  ])), 0, 16)
  admin_token = var.admin_token != "" ? var.admin_token : "sk-sy-admin-${random_password.admin_token.result}"

  values = {
    image = {
      repository = var.image.repository
      tag        = var.image.tag
      digest     = var.image.digest
      pullPolicy = var.image.pull_policy
    }
    config = var.gateway_config
    secrets = {
      create         = false
      existingSecret = kubernetes_secret_v1.this.metadata[0].name
    }
    api = {
      replicaCount = var.api_replicas
      resources    = var.resources.api
      autoscaling = {
        enabled                        = var.autoscaling.enabled
        minReplicas                    = var.autoscaling.min
        maxReplicas                    = var.autoscaling.max
        targetCPUUtilizationPercentage = var.autoscaling.cpu_percent
      }
    }
    worker = {
      replicaCount = var.worker_replicas
      resources    = var.resources.worker
    }
    service = {
      type     = var.service.type
      nodePort = var.service.node_port # null → chart default (no fixed nodePort)
    }
    metrics = {
      serviceMonitor = { enabled = var.monitoring.service_monitor }
      prometheusRule = { enabled = var.monitoring.prometheus_rule }
    }
  }
}

resource "kubernetes_namespace_v1" "this" {
  count = var.create_namespace ? 1 : 0
  metadata {
    name   = var.namespace
    labels = merge(local.labels, { "pod-security.kubernetes.io/enforce" = "restricted" })
  }
}

resource "random_password" "admin_token" {
  length  = 40
  special = false
}

resource "kubernetes_secret_v1" "this" {
  metadata {
    name      = "${var.release_name}-env"
    namespace = local.namespace
    labels    = local.labels
  }
  data = merge(var.extra_secret_env, {
    SWITCHYARD_ADMIN_TOKEN = local.admin_token
    DATABASE_URL           = var.database_url
    REDIS_URL              = var.redis_url
  })
}

resource "helm_release" "this" {
  name      = var.release_name
  namespace = local.namespace
  chart     = var.chart_path
  atomic    = true
  wait      = true
  timeout   = 600

  # pricing is `any`-typed (arbitrary JSON), so it travels as its own values document instead of
  # through a conditional inside local.values (HCL conditionals need matching object types).
  values = concat(
    [yamlencode(local.values)],
    var.pricing == null ? [] : [yamlencode({ pricing = var.pricing })],
    var.extra_values,
  )

  # Local charts are not versioned per edit; changing the description makes Terraform upgrade
  # the release whenever any chart file changes.
  description = "switchyard chart ${local.chart_hash}"
}
