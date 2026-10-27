# Deploying Switchyard

One container image runs every process: `serve` (the API), `worker` (usage stream to Postgres)
and `migrate` (schema). On top of that image there are four ways to run it:

| Path                                   | What you get                                                                                        | Entry point                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------- |
| [Docker Compose](#docker-compose)      | The full stack on one machine: gateway, worker, Redis, Postgres, mock upstream, Prometheus, Grafana | `make compose-up`                       |
| [Helm](#helm)                          | The gateway on any Kubernetes cluster; you bring Redis 8 and Postgres                               | `deploy/helm/switchyard`                |
| [Terraform + kind](#terraform--kind)   | A local Kubernetes cluster with everything, including kube-prometheus-stack and the dashboards      | `make k8s-up`                           |
| [Terraform + EKS](#amazon-eks-example) | A reference layout for AWS. It is validated, but this project never applies it                      | `deploy/terraform/envs/aws-eks-example` |

Monitoring is covered in [OBSERVABILITY.md](OBSERVABILITY.md), and the admin API and key
management in [ADMIN.md](ADMIN.md).

## The image

`deploy/docker/Dockerfile` is a multi-stage pnpm build on
`gcr.io/distroless/nodejs24-debian13:nonroot`.

- **Size:** 188 MB uncompressed, about 65 MB compressed. CI fails the build at 200 MB.
- **Pinning:** every base image is pinned by digest.
- **Runs as:** uid 65532, with no shell and no package manager.

```bash
make image                      # → switchyard:dev with OCI labels (version, revision, created)
docker run --rm switchyard:dev --version
docker run --rm switchyard:dev validate-config /etc/switchyard/gateway.yaml   # mount your config
```

| Setting                     | Value                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| Entrypoint / default cmd    | `node /app/dist/cli.js` / `serve`                                                                |
| `SWITCHYARD_CONFIG`         | `/etc/switchyard/gateway.yaml` (used by every subcommand when `--config` is absent)              |
| `SWITCHYARD_MIGRATIONS_DIR` | `/app/drizzle`                                                                                   |
| Built-in pricing            | `/app/config/pricing.json`. Mount your own and point `pricing_file` at it to override.           |
| Ports                       | 8787 API, 9464 gateway metrics, 9465 worker metrics/health, 8790 mock provider                   |
| Filesystem                  | Works with a read-only root filesystem. It only needs a writable `/tmp` for `seed-dev --output`. |

Images are published to `ghcr.io/riz1-k/switchyard` for linux/amd64 and linux/arm64, with SBOM
and provenance attestations (`.github/workflows/docker.yml`):

- **Every release:** `<version>`, `<major>.<minor>` and `latest`. The release workflow calls the
  Docker workflow after the npm publish (see [RELEASING.md](RELEASING.md)).
- **`main`:** `edge` and `sha-<short>`.

Pin a version tag, or a digest, in production.

## Configuration and secrets

The gateway reads one YAML file. Any `${VAR}` or `${VAR:-default}` in it is resolved from the
environment at load time, so the file itself can be a ConfigMap or bind mount with no secrets
in it:

| Variable                 | Used for                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `SWITCHYARD_ADMIN_TOKEN` | Admin API bearer token (`auth.admin_token`). It is also required for `/readyz?probe=1`. |
| `DATABASE_URL`           | `postgres://…/llmgateway` (`database.url`; `migrate` also reads it directly)            |
| `REDIS_URL`              | `redis://…:6379/0` (`redis.url`). Must be a single Redis 8 primary.                     |
| provider keys            | Whatever your providers reference, e.g. `OPENAI_API_KEY`, `OPENCODE_SERVER_PASSWORD`    |

`config/gateway.compose.yaml` is the containerised demo config, shared by compose and kind.
Four simulated providers point at the bundled mock server and differ only in fault-injection
headers: a healthy one, a slow one, one returning about 30 % 503s, and one returning about
60 % 429s. Teams and keys live in Postgres and are created by `switchyard seed-dev` or the admin
API. Validate any config with `switchyard validate-config <file>`.

## Docker Compose

`deploy/docker/docker-compose.yml` (project name `switchyard`) is a local, loopback-only stack.
Each service has a memory limit, so the whole stack fits in about 2.5 GB:

| Service         | Image                     | Host port                          | Limit  | Notes                                                                                                                                                  |
| --------------- | ------------------------- | ---------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gateway`       | `switchyard:dev`          | `127.0.0.1:8797`                   | 384 MB | `serve`. Healthcheck on `/readyz`. Metrics on :9464 (container network only).                                                                          |
| `worker`        | `switchyard:dev`          | none                               | 192 MB | `worker --port 9465`                                                                                                                                   |
| `migrate`       | `switchyard:dev`          | none                               | none   | One-shot. `gateway` and `worker` wait for `service_completed_successfully`.                                                                            |
| `mock-provider` | `switchyard:dev`          | none                               | 128 MB | `mock-provider --port 8790`                                                                                                                            |
| `postgres`      | `postgres:18.6-alpine`    | `127.0.0.1:55432`                  | 256 MB | DB `llmgateway`. An init script creates the read-only `grafana_reader` role.                                                                           |
| `redis`         | `redis:8.8.4-alpine`      | `127.0.0.1:56379`                  | 256 MB | AOF, `maxmemory 192mb`, `noeviction`                                                                                                                   |
| `prometheus`    | `prom/prometheus:v3.15.1` | `127.0.0.1:9091`                   | 384 MB | Scrapes gateway and worker, loads `observability/prometheus/alerts.yml`                                                                                |
| `tempo`         | `grafana/tempo:3.1.1`     | `127.0.0.1:3201`, `127.0.0.1:4319` | 256 MB | Traces: Tempo API, and OTLP/HTTP for other local services. 24 h retention. The gateway exports to it (`SWITCHYARD_OTEL_ENABLED=false` turns that off). |
| `grafana`       | `grafana/grafana:13.2.4`  | `127.0.0.1:3301`                   | 512 MB | Provisioned datasources (Prometheus, Postgres, Tempo) and the three dashboards                                                                         |
| `seed`          | `switchyard:dev`          | none                               | none   | Profile `demo`: `seed-dev` creates the docsqa/opsagent/evals teams and writes keys only to a 0600 file in the container.                               |

The host ports deliberately avoid the usual ones (5432, 6379, 8787, 9090, 3000), so the stack can
run next to native services.

```bash
make compose-up      # builds the image, starts everything, waits for healthchecks
make compose-demo    # seed + 120 s of mixed traffic (DEMO_SECONDS=…); exits non-zero unless it saw
                     # cache hits, fallbacks, a 429 and a 402
open http://127.0.0.1:3301   # admin / switchyard-local → Dashboards → Switchyard
make compose-down    # stop and delete volumes (always -v; use compose-stop to keep data)
```

`deploy/demo/traffic.mjs` has no dependencies and works against any Switchyard URL (`--url`,
`--admin-token`, `--duration`, `--concurrency`). It does the following:

- creates the teams `docsqa`, `opsagent`, `evals` and a `sandbox` team with a $0.002 budget
  (so 402s show up)
- rotates its own `demo-traffic` keys, plus one key limited to 5 RPM (so 429s show up)
- sends a weighted mix of RAG chat (some streamed), fast and judge calls, embeddings, rerank and
  tool-calling chat, with repeated prompts so the cache gets hits

Overrides live in `deploy/docker/.env`; see `.env.example` for image, passwords, log level and
host ports. The defaults are demo credentials bound to 127.0.0.1. Change them before you bind
any port to another interface.

### Using host services

The `gateway` service maps `host.docker.internal` to the host gateway. To use real upstreams
running on the host, such as opencode on :4096 or llama.cpp on :8081–8083, add a provider to a
copy of the config:

```yaml
providers:
  copilot:
    type: opencode
    base_url: http://host.docker.internal:4096
    password: ${OPENCODE_SERVER_PASSWORD}
  local-embed:
    type: openai-compatible
    base_url: http://host.docker.internal:8082/v1
```

The host service must listen on an address the Docker bridge can reach (`0.0.0.0` or the
bridge IP, not only 127.0.0.1). Pass secrets through `environment:` or a compose `secrets:`
file, never in the YAML.

## Helm

The chart lives in `deploy/helm/switchyard`. Its [README](../deploy/helm/switchyard/README.md)
has the full values table.

```bash
kubectl create namespace switchyard
kubectl -n switchyard create secret generic switchyard-env \
  --from-literal=SWITCHYARD_ADMIN_TOKEN="$(openssl rand -hex 24)" \
  --from-literal=DATABASE_URL='postgres://switchyard:…@postgres:5432/llmgateway' \
  --from-literal=REDIS_URL='redis://redis:6379/0'
# my-values.yaml holds your gateway.yaml under a top-level `config:` key
helm install switchyard deploy/helm/switchyard -n switchyard \
  --set secrets.create=false --set secrets.existingSecret=switchyard-env -f my-values.yaml
helm test switchyard -n switchyard
```

- **Install and upgrade:** a `pre-install,pre-upgrade` hook Job runs `switchyard migrate` before
  any new pod starts. Migrations are additive and advisory-locked, so a failed hook leaves the
  old ReplicaSet serving. The API pods roll when the config or secret checksum changes.
  `config.server.shutdown_grace_ms` plus `api.preStopSleepSeconds` must stay below
  `terminationGracePeriodSeconds`.
- **Probes:**
  - startup and liveness: `/healthz` (process only)
  - readiness: `/readyz` (Redis and Postgres). It returns 503 while the pod drains, so it drops
    out of the Service.
  - `/readyz?probe=1` also probes the upstream providers. It needs the admin token, so it is
    not suitable as a kubelet probe.
- **Scaling:**
  - `api.autoscaling` scales on CPU. Switchyard is I/O-bound, so a Pods metric on
    `sy_inflight_requests` (via prometheus-adapter) in `api.autoscaling.metrics` tracks load
    better.
  - The worker is one consumer group, so it scales horizontally. Add replicas when
    `sy_usage_stream_lag` grows.
  - All replicas share rate limits, budgets, the cache and breaker state through Redis, so you
    don't need sticky sessions.
- **Ingress:** for SSE streaming, turn off proxy buffering and raise read timeouts above
  `server.request_timeout_ms`. For ingress-nginx:
  ```yaml
  nginx.ingress.kubernetes.io/proxy-buffering: 'off'
  nginx.ingress.kubernetes.io/proxy-read-timeout: '300'
  ```
  Metrics use separate Services, so an Ingress cannot expose them.
- **Monitoring:**
  - `metrics.serviceMonitor.enabled` and `metrics.prometheusRule.enabled` need the Prometheus
    Operator CRDs; nothing is rendered without them.
  - The PrometheusRule ships `files/alerts.yml`, a copy of
    `observability/prometheus/alerts.yml` kept in sync by `make chart-sync`. `make lint-alerts`
    fails if the two differ.

Validate with `make lint-helm`, which runs `helm lint` plus `kubeconform -strict` against
Kubernetes 1.37 for both `ci/*-values.yaml` files.

## Terraform + kind

`deploy/terraform` contains four reusable modules and two environments:

| Module          | Creates                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `switchyard`    | Optional namespace (PSA `restricted`), the env Secret (generated admin token, `DATABASE_URL`, `REDIS_URL`) and a `helm_release` of the local chart with `secrets.existingSecret`             |
| `postgres`      | Postgres 18 StatefulSet + PVC, Service, Secret and initdb ConfigMap (read-only `grafana_reader` role). Outputs `database_url`.                                                               |
| `redis`         | Redis 8 StatefulSet + PVC (AOF, `noeviction`, read-only root filesystem), optional password. Outputs `url`.                                                                                  |
| `observability` | kube-prometheus-stack 92.14.0 (Prometheus Operator, Prometheus, Grafana, kube-state-metrics), the Postgres datasource, and the dashboards as sidecar-loaded ConfigMaps (folder "Switchyard") |

Secrets are created as Kubernetes Secrets by Terraform rather than passed as chart values, so
they never appear in Helm release history. They are still in Terraform state. Use an encrypted
remote backend outside local experiments.

`envs/local-kind` builds everything on one machine:

1. A kind cluster (Kubernetes 1.37, node image pinned by digest) with host port mappings
   `127.0.0.1:8797 → NodePort 30787` (gateway) and `127.0.0.1:3301 → NodePort 30300` (Grafana).
2. `docker build` of this checkout and `kind load docker-image`. This re-runs when sources
   change, and the pods use `imagePullPolicy: Never`.
3. Postgres and Redis (modules), the mock provider Deployment, the Switchyard chart with
   `config/gateway.compose.yaml`, ServiceMonitors and the PrometheusRule.
4. kube-prometheus-stack in `monitoring`, in a small-footprint profile: no Alertmanager, no
   node-exporter, a trimmed set of default rules, and resource limits on everything.
5. metrics-server, which kind lacks, so that `kubectl top` and CPU-based HPAs work.
6. A seed Job (`seed-dev`) that creates the docsqa/opsagent/evals teams.

```bash
make k8s-up          # terraform init + apply (first run ≈ 5–10 min, mostly image pulls)
make k8s-demo        # traffic.mjs through the NodePort, admin token from `terraform output`
terraform -chdir=deploy/terraform/envs/local-kind output -raw grafana_admin_password
export KUBECONFIG=deploy/terraform/envs/local-kind/.kubeconfig   # written by the kind provider
kubectl get pods -A && kubectl top pods -A
make k8s-down        # terraform destroy (deletes the cluster)
```

Plan for about 3 GB of free RAM and about 6 GB of disk while it runs. In the verification run,
the node used about 2.5 GB, of which Grafana took 414 MB, Prometheus 260 MB and each API pod
about 160 MB. Set
`-var observability_enabled=false` to skip kube-prometheus-stack on small machines. Set
`-var 'preload_images=["docker.io/grafana/grafana:13.2.4"]'` to side-load images already in your
Docker daemon instead of pulling them. kind stages each image as a tarball in `$TMPDIR`.

## Amazon EKS example

`envs/aws-eks-example` is a reference layout. It passes `terraform validate` and tflint, but
this project has never applied it.

- VPC (terraform-aws-modules/vpc 6.7.3) and EKS 1.35 (terraform-aws-modules/eks 21.29.0) with
  one managed node group. Core addons, plus the EBS CSI driver through an EKS Pod Identity role.
- A gp3 default StorageClass, the same `postgres`, `redis`, `observability` and `switchyard`
  modules, the image from `ghcr.io/riz1-k/switchyard`, and an optional ALB Ingress.

For production:

- Use RDS for PostgreSQL instead of the StatefulSet.
- Keep Redis on Redis 8 (Redis Cloud / Redis Software, or the StatefulSet). The semantic cache
  needs vector sets, and Valkey-based ElastiCache/MemoryDB does not provide them.
- Use a remote state backend with encryption.
- Put the admin token and provider keys in AWS Secrets Manager, synced with External Secrets,
  and pass `existing_secret`.

## Redis sizing

Redis holds four kinds of data:

- **Usage stream (`sy:usage`):** one entry per request until the worker acknowledges it. Entries
  are about 700 B. `usage.stream_maxlen` caps the stream (approximate `MAXLEN ~`; default 1 000 000,
  set to **100 000** in the compose/kind config and the chart). Budget
  `stream_maxlen × 700 B` for a stalled worker: about 70 MB at 100k, 700 MB at the default.
  If the worker falls behind by more than the cap, the oldest unprocessed events are trimmed,
  which loses usage data. `SwitchyardUsageStreamLag` warns at 10 000.
- **Exact cache:** gzip-compressed responses with per-route TTLs. Size this from
  hit-able traffic × TTL × compressed response size (typically 1–5 KB).
- **Semantic cache:** vector-set entries stored unquantised (`NOQUANT`, so 4 bytes per
  embedding dimension) plus the cached payload.
- **Rate-limit windows, budget counters, breaker state, key cache:** small, roughly linear in
  active keys × routes.

Run Redis with `maxmemory` set and `maxmemory-policy noeviction`. Eviction could silently drop
stream entries or limit counters. Cache keys carry TTLs. Turn on AOF (`appendonly yes`) so
unprocessed usage events survive a restart. Redis Cluster is not supported. Use one primary, and
separate environments with `redis.key_prefix` or db numbers.

## Upgrades and rollbacks

1. Build or pull the new image and read the release notes for config changes. Run
   `switchyard validate-config` against your config with the new image.
2. Compose: `make compose-up` re-runs `migrate`. Helm: `helm upgrade` runs the migration hook
   first. Terraform: `terraform apply`.
3. Migrations only add things, so rolling back the image (`helm rollback`) is safe. The database
   schema is not rolled back.
4. Config-only changes: Helm rolls the pods. Compose or bare processes can reload the config
   without restarting with `SIGHUP` or `POST /admin/config/reload`.
