# switchyard Helm chart

Deploys the [Switchyard](../../../README.md) LLM gateway on Kubernetes: the API Deployment
(`switchyard serve`), the usage writer (`switchyard worker`), a migration hook Job, Services,
optional Ingress/HPA/PDB, and Prometheus Operator integration (ServiceMonitors and a
PrometheusRule built from `observability/prometheus/alerts.yml`).

Redis 8 and Postgres 18 are **not** part of the chart. Point it at managed services, or use the
Terraform modules in `deploy/terraform/modules/{redis,postgres}` for a self-contained cluster.

```bash
helm install switchyard deploy/helm/switchyard -n switchyard --create-namespace \
  --set secrets.databaseUrl='postgres://switchyard:…@pg:5432/llmgateway' \
  --set secrets.redisUrl='redis://redis:6379/0'
# production: keep secrets out of values
kubectl -n switchyard create secret generic switchyard-env \
  --from-literal=SWITCHYARD_ADMIN_TOKEN=… --from-literal=DATABASE_URL=… --from-literal=REDIS_URL=…
helm install switchyard deploy/helm/switchyard -n switchyard \
  --set secrets.create=false --set secrets.existingSecret=switchyard-env -f my-values.yaml
helm test switchyard -n switchyard
```

## What gets rendered

| Resource                                 | Notes                                                                                                                                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Deployment/<release>-switchyard`        | `serve`. Startup and liveness probes on `/healthz`, readiness on `/readyz` (Redis + Postgres). A preStop sleep lets endpoints drain before SIGTERM. Config/secret checksums roll pods on change. Soft topology spread over hostname and zone. |
| `Deployment/<release>-switchyard-worker` | `worker --port 9465`: drains the Redis usage stream into Postgres through a consumer group, so it scales horizontally. Probes on the worker's `/healthz`.                                                                                     |
| `Job/<release>-switchyard-migrate`       | `pre-install,pre-upgrade` hook running `switchyard migrate`, which is idempotent and takes a Postgres advisory lock. It uses its own hook Secret, because the release Secret does not exist yet on first install.                             |
| `ConfigMap`                              | `gateway.yaml` (from `config`, with ports forced to match the containers) and optionally `pricing.json`.                                                                                                                                      |
| `Secret`                                 | `SWITCHYARD_ADMIN_TOKEN` (generated once, then kept via `lookup`), `DATABASE_URL`, `REDIS_URL` and `extraEnv`. Skipped when `secrets.existingSecret` is set.                                                                                  |
| `Service` ×3                             | The API service (ClusterIP / NodePort / LoadBalancer), plus `-metrics` and `-worker-metrics` ClusterIP services labelled `switchyard.dev/metrics: "true"`. Metrics never share the API port, so an Ingress cannot expose them.                |
| `Ingress`, `HPA` ×2, `PDB` ×2            | Optional.                                                                                                                                                                                                                                     |
| `ServiceMonitor` ×2, `PrometheusRule`    | Only rendered when `monitoring.coreos.com/v1` is served by the cluster.                                                                                                                                                                       |
| `Pod/<release>-switchyard-test-readyz`   | `helm test` hook.                                                                                                                                                                                                                             |

Every pod runs as uid 65532 with a read-only root filesystem, all capabilities dropped and the
RuntimeDefault seccomp profile. The chart passes the `restricted` Pod Security Standard.

## Values

| Key                                                 | Default                     | Description                                                                                                                         |
| --------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `image.repository`                                  | `ghcr.io/riz1-k/switchyard` | One image for serve, worker and migrate.                                                                                            |
| `image.tag`                                         | `""` (appVersion)           | Image tag.                                                                                                                          |
| `image.digest`                                      | `""`                        | `sha256:…`; takes precedence over the tag.                                                                                          |
| `image.pullPolicy`                                  | `IfNotPresent`              |                                                                                                                                     |
| `imagePullSecrets`                                  | `[]`                        |                                                                                                                                     |
| `nameOverride` / `fullnameOverride`                 | `""`                        |                                                                                                                                     |
| `config`                                            | mock-provider config        | `gateway.yaml` as YAML. `${VAR}` placeholders are resolved from the pod environment. See `config/gateway.example.yaml`.             |
| `config.usage.stream_maxlen`                        | `100000`                    | Approximate MAXLEN of the Redis usage stream (about 700 B per entry). See [Redis sizing](../../../docs/DEPLOYMENT.md#redis-sizing). |
| `config.usage.in_process_writer`                    | `false`                     | Keep `false` while `worker.enabled`.                                                                                                |
| `pricing`                                           | `{}`                        | Pricing table (format of `config/pricing.json`). If empty, the image's built-in table is used.                                      |
| `existingConfigMap`                                 | `""`                        | Use your own ConfigMap (`gateway.yaml`, optionally `pricing.json`).                                                                 |
| `secrets.create`                                    | `true`                      | Render a Secret from the values below.                                                                                              |
| `secrets.existingSecret`                            | `""`                        | Secret consumed via `envFrom`. Keys: `SWITCHYARD_ADMIN_TOKEN`, `DATABASE_URL`, `REDIS_URL` and any provider keys.                   |
| `secrets.adminToken`                                | `""` (generated)            | Admin API token. Kept across upgrades.                                                                                              |
| `secrets.databaseUrl`                               | `""`                        | Required when `secrets.create`.                                                                                                     |
| `secrets.redisUrl`                                  | `""`                        | Required when `secrets.create`. Must be a single Redis 8 primary (vector sets are used for the semantic cache).                     |
| `secrets.extraEnv`                                  | `{}`                        | Extra secret env vars (e.g. `OPENAI_API_KEY`).                                                                                      |
| `env`                                               | `{}`                        | Extra plain env vars for every container.                                                                                           |
| `tracing.enabled`                                   | `false`                     | Turn on OpenTelemetry tracing: sets `observability.otel.enabled: true` in the rendered config. See [Tracing](#tracing).             |
| `tracing.endpoint`                                  | `""`                        | OTLP/HTTP base URL (`OTEL_EXPORTER_OTLP_ENDPOINT`), e.g. `http://tempo.observability:4318`. Empty: `http://localhost:4318`.         |
| `tracing.sampleRatio`                               | `1`                         | Share of new traces to record (`OTEL_TRACES_SAMPLER=parentbased_traceidratio`). A caller's `traceparent` decision always wins.      |
| `tracing.serviceName`                               | `""` (`switchyard`)         | `OTEL_SERVICE_NAME`.                                                                                                                |
| `tracing.resourceAttributes`                        | `{}`                        | Extra `OTEL_RESOURCE_ATTRIBUTES`. `k8s.namespace.name` and `k8s.pod.name` are always added.                                         |
| `serviceAccount.create` / `name` / `annotations`    | `true` / `""` / `{}`        | For IRSA / Workload Identity, use the annotations.                                                                                  |
| `serviceAccount.automountServiceAccountToken`       | `false`                     | Switchyard never talks to the Kubernetes API.                                                                                       |
| `podSecurityContext`                                | non-root 65532, seccomp     |                                                                                                                                     |
| `securityContext`                                   | read-only rootfs, drop ALL  |                                                                                                                                     |
| `api.replicaCount`                                  | `2`                         | Ignored when autoscaling is on.                                                                                                     |
| `api.port` / `api.metricsPort`                      | `8787` / `9464`             | Forced into `config.server.port` / `config.metrics.port`.                                                                           |
| `api.resources`                                     | 100m / 128Mi, limit 384Mi   |                                                                                                                                     |
| `api.autoscaling.*`                                 | off, 2–10, 70 % CPU         | Plus `metrics` (e.g. `sy_inflight_requests` via prometheus-adapter) and `behavior`.                                                 |
| `api.pdb.enabled` / `minAvailable`                  | `true` / `1`                |                                                                                                                                     |
| `api.topologySpread.*`                              | on, skew 1, ScheduleAnyway  | Spread over `kubernetes.io/hostname` and `topology.kubernetes.io/zone`.                                                             |
| `api.terminationGracePeriodSeconds`                 | `30`                        | Keep it above `config.server.shutdown_grace_ms` plus the preStop sleep.                                                             |
| `api.preStopSleepSeconds`                           | `5`                         | `0` disables the preStop hook.                                                                                                      |
| `api.podAnnotations` / `podLabels`                  | `{}`                        |                                                                                                                                     |
| `api.nodeSelector` / `tolerations` / `affinity`     | `{}` / `[]` / `{}`          |                                                                                                                                     |
| `api.priorityClassName` / `extraArgs`               | `""` / `[]`                 |                                                                                                                                     |
| `worker.enabled`                                    | `true`                      | If disabled, set `config.usage.in_process_writer: true`.                                                                            |
| `worker.replicaCount` / `metricsPort`               | `1` / `9465`                |                                                                                                                                     |
| `worker.resources`                                  | 50m / 96Mi, limit 256Mi     |                                                                                                                                     |
| `worker.autoscaling.*` / `worker.pdb.*`             | off / off                   | Same shape as `api.*`.                                                                                                              |
| `worker.*` scheduling keys                          | as `api.*`                  |                                                                                                                                     |
| `migrations.enabled`                                | `true`                      | Pre-install/pre-upgrade migration Job.                                                                                              |
| `migrations.backoffLimit` / `activeDeadlineSeconds` | `3` / `300`                 |                                                                                                                                     |
| `migrations.ttlSecondsAfterFinished`                | `600`                       |                                                                                                                                     |
| `migrations.resources`                              | 50m / 96Mi, limit 192Mi     |                                                                                                                                     |
| `service.type` / `port` / `nodePort`                | `ClusterIP` / `8787` / null |                                                                                                                                     |
| `service.annotations` / `labels`                    | `{}`                        |                                                                                                                                     |
| `ingress.enabled` / `className` / `annotations`     | `false` / `""` / `{}`       | Streaming (SSE) needs proxy buffering off and long read timeouts on the controller.                                                 |
| `ingress.hosts` / `tls`                             | example host / `[]`         |                                                                                                                                     |
| `metrics.serviceMonitor.enabled`                    | `false`                     | ServiceMonitors for API and worker metrics.                                                                                         |
| `metrics.serviceMonitor.interval` / `scrapeTimeout` | `15s` / `10s`               |                                                                                                                                     |
| `metrics.serviceMonitor.labels`                     | `{}`                        | E.g. `release: kube-prometheus-stack` if your Prometheus selects on it.                                                             |
| `metrics.prometheusRule.enabled` / `labels`         | `false` / `{}`              | Ships `files/alerts.yml`, a copy of `observability/prometheus/alerts.yml` kept in sync by `make chart-sync`.                        |
| `tests.enabled`                                     | `true`                      | `helm test` pod that checks `/readyz`.                                                                                              |

`values.schema.json` validates all of the above. Unknown keys are rejected, except inside
free-form maps (`config`, `pricing`, `env`, `secrets.extraEnv`, annotations and labels).

## Tracing

```yaml
tracing:
  enabled: true
  endpoint: http://tempo.observability:4318 # or an OpenTelemetry Collector
  sampleRatio: 0.1
  resourceAttributes:
    deployment.environment.name: prod
```

With `tracing.enabled`, the chart sets `observability.otel.enabled: true` in `gateway.yaml` and
passes the rest as standard `OTEL_*` variables, plus `k8s.namespace.name` and `k8s.pod.name`
from the downward API. Values written under `config.observability.otel` win over these
variables ([OBSERVABILITY.md § Tracing](../../../docs/OBSERVABILITY.md#tracing)). The image
already contains the OpenTelemetry SDK. For collector auth, put
`OTEL_EXPORTER_OTLP_HEADERS` in `secrets.extraEnv` or the existing Secret. The worker and
migration pods get the same variables but do not trace.

## Validation

```bash
make lint-helm   # helm lint + kubeconform -strict for ci/default-values.yaml and ci/full-values.yaml
```
