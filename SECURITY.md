# Security policy

## Supported versions

Switchyard is pre-1.0. Security fixes go to the latest release on npm (`switchyard-gateway`) and
the latest container image. Older versions are not patched; please upgrade.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's
[private vulnerability reporting](https://github.com/riz1-k/llm-gateway/security/advisories/new)
(the repository's **Security** tab → **Report a vulnerability**). Please include:

- the affected version or commit, and your configuration (redact secrets);
- what you can do as which actor (unauthenticated client, virtual-key holder or admin);
- steps or a proof of concept, and the impact you observed.

What to expect:

- an acknowledgement within 5 working days;
- an assessment, and a fix or mitigation plan, within 30 days for confirmed issues;
- credit in the advisory and the changelog, unless you prefer to stay anonymous.

Please give us reasonable time to release a fix before you disclose publicly.

## Scope

**In scope:**

- the gateway library and CLI (`packages/gateway`);
- the bundled mock provider;
- the Docker image, the Helm chart and the shipped configs.

The following are especially relevant:

- authentication and authorization bypasses (virtual keys, admin API);
- cross-team data exposure (cache, usage, admin views);
- budget, rate-limit or usage-ledger evasion;
- resource-exhaustion bugs that a single request or key can trigger;
- injection, and credential or secret leaks (logs, errors, `/admin/config`).

**Out of scope:**

- **Upstream providers:** vulnerabilities in the providers themselves, or in opencode.
- **Model prompt injection:** behaviour of the model itself in response to prompt injection.
  Tool calls are returned to the client and never executed by the gateway.
- **Unsafe settings in your own deployment:** for example `allow_header_faults: true`,
  `cache.shared: true`, `/metrics` exposed publicly, or the `sk-sy-dev-*` development keys used
  outside localhost.
- **Demo defaults:** default credentials in the local and demo files
  (`config/gateway.local.yaml`, `deploy/docker/docker-compose.yml`). They bind to `127.0.0.1` and
  are documented as dev-only.

## Verifying artifacts

Container images are signed with cosign (keyless, GitHub OIDC) and carry SBOM and SLSA
build-provenance attestations; npm releases are published with provenance. Verification
commands: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#verifying-the-image).

## Hardening notes

See [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md) for the threat model, the last review's
findings and the accepted residual risks.

### Known residual risks

These are accepted and documented. Reports that only restate them are out of scope, but ideas
for closing them are welcome:

- **Budget overshoot under concurrency (SR-14):** budgets are a pre-flight check plus a
  reconciliation after the response. Concurrent requests from one team can overshoot by at most
  in-flight requests × cost per request. RPM/TPM and provider concurrency limits cap this.
- **Fail-open on Redis outages (SR-15):** with the default `redis.fail_open: true`, rate limits
  and budgets are skipped (and logged) while Redis is down. Key verification still fails closed.
- **`/metrics` content (SR-16):** it exposes team slugs, route names and spend. Serve it on
  `metrics.port`.
- **No request timeout on long generations (SR-17):** run the gateway behind a proxy with
  connection limits and timeouts.
- **One full-rights admin token (SR-18):** there is no RBAC yet.
- **Admin-configured webhooks (SR-20):** they can reach any URL the gateway can reach.
- **Tool arguments are untrusted (SR-21):** the gateway validates emulated tool calls but never
  executes them. Clients must treat the arguments as untrusted.

### Production checklist

In short, for production:

- set a long random `SWITCHYARD_ADMIN_TOKEN`;
- use database-issued keys;
- serve `/metrics` on `metrics.port`;
- consider `redis.fail_open: false` for paid upstreams;
- run behind a reverse proxy with connection limits and timeouts;
- keep the mock provider out of production routes.
