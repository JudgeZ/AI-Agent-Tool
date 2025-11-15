# Helm Values Reference

The `oss-ai-agent-tool` chart exposes the following configuration knobs. Defaults shown below match `charts/oss-ai-agent-tool/values.yaml`.

## Global

| Key | Default | Description |
| - | - | - |
| `image.repo` | `ghcr.io/yourorg/oss-ai-agent-tool` | Base container repository. |
| `image.tag` | `0.1.0` | Immutable image tag. |
| `image.pullPolicy` | `IfNotPresent` | Pod-level pull policy. |
| `runMode` | `consumer` | Controls orchestrator/compliance defaults (`enterprise` switches secrets backend, message bus). |
| `messaging.type` | `rabbitmq` | `rabbitmq` or `kafka`. Determines which adapter is deployed and configured. |
| `podSecurityContext.*` | non-root UID/GID | Applied to all pods. |
| `containerSecurityContext.*` | read-only rootfs, no privileges | Hardened defaults shared across workloads. |

## Network Policy

| Key | Default | Notes |
| - | - | - |
| `networkPolicy.enabled` | `true` | Generates namespace-scoped ingress + curated egress. |
| `networkPolicy.defaultDenyEgress` | `true` | Enforces default-deny; set to `false` for permissive mode. |
| `networkPolicy.egressRules` | DNS + Jaeger | Append rules to allow additional destinations. Set `networkPolicy.egress` to override entirely. |

## Mutual TLS

The chart can now provision and rotate internal certificates automatically. Enable the feature by pointing the chart at a cert-manager issuer:

```yaml
mtls:
  enabled: true
  certManager:
    issuerRef:
      name: ossaat-internal-ca
      kind: ClusterIssuer
      group: cert-manager.io
```

With `mtls.enabled=true` the chart:

1. Issues two `Certificate` resources (server + client) via cert-manager and stores them in the secrets computed by `gatewayApi.tls.secretName` and `orchestrator.tls.secretName` (defaulting to `<release>-gateway-orchestrator-mtls` and `<release>-orchestrator-mtls`).
2. Forces the orchestrator to listen over HTTPS with client certificates required.
3. Configures the gateway to present the generated client certificate, validates the orchestrator using the shared CA bundle, and updates `ORCHESTRATOR_URL` to `https://`.
4. Switches liveness/readiness probes to HTTPS so health checks continue to succeed.

Override SANs or subject information with `mtls.orchestrator.additionalDnsNames` and `mtls.gateway.client.*`. When you prefer to manage secrets yourself, keep `mtls.enabled=false`, set `certManager.enabled=false`, and provide the secret names under `orchestrator.tls.secretName` and `gatewayApi.tls.secretName` (for example by creating secrets with `kubectl create secret generic ...`).

## Gateway API (`gatewayApi`)

| Key | Default | Notes |
| - | - | - |
| `replicas` | `2` | Horizontal scaling for the HTTP edge. |
| `containerPort` | `8080` | Pod port. Service exposes port `80` by default. |
| `env` | `{}` | Extra environment variables. |
| `tls.enabled` | `false` | Enable when orchestrator requires mTLS. Automatically forced to `true` when `mtls.enabled`. |
| `tls.secretName` | `""` | Secret containing client cert/key/CA. Defaults to `<release>-gateway-orchestrator-mtls` when `mtls` is enabled. |
| `tls.mountPath` | `/etc/orchestrator/tls` | Mount location inside the pod. |
| `tls.clientCertFile` | `client.crt` | File name inside the secret. |
| `tls.clientKeyFile` | `client.key` | File name inside the secret. |
| `tls.caFile` | `ca.crt` | Optional CA bundle path (defaults to `ca.crt` for chart-managed secrets). |
| `tls.serverName` | `""` | Override the TLS SNI/verification host (defaults to the orchestrator service FQDN). |
| `resources` | Requests 100m/128Mi, limits 500m/256Mi | Adjust for load. |
| `podDisruptionBudget.enabled` | `true` | Creates a PodDisruptionBudget for the gateway. Disable to opt out. |
| `podDisruptionBudget.minAvailable` | `1` | Minimum available pods during voluntary disruptions (set `maxUnavailable` instead if preferred). |

Use `gatewayApi.env` to surface the global HTTP rate limit knobs exposed by the gateway. Setting `GATEWAY_HTTP_IP_RATE_LIMIT_WINDOW` (default `1m`) and `GATEWAY_HTTP_IP_RATE_LIMIT_MAX` (default `120`, `0` disables) adds a coarse, per-IP circuit breaker in front of every route. The legacy fallbacks `GATEWAY_HTTP_RATE_LIMIT_WINDOW`/`MAX` still work when the IP-specific variables are omitted. Keep these values higher than the auth-specific buckets configured via `gatewayApi.rateLimit.auth.*` and the SSE connection quotas (`gatewayApi.sse.maxConnectionsPerIP`) so legitimate users do not hit conflicting throttles.

## Orchestrator (`orchestrator`)

| Key | Default | Notes |
| - | - | - |
| `replicas` | `2` | API server replicas. |
| `containerPort` | `4000` | Cluster service also defaults to `4000`. |
| `env` | `{ LOCAL_SECRETS_PATH, LOCAL_SECRETS_PASSPHRASE }` | Baseline local secrets config; override for Vault/Secrets Manager. |
| `database.postgres.minConnections` | `2` | Minimum connections kept alive per pod; set to `0` to disable pre-warming. |
| `database.postgres.statementTimeoutMs` / `queryTimeoutMs` | `5000` | Server-side and client-side query timeouts (ms). Set to `0` to disable individually. |
| `policy.cache` | `enabled: false`, memory backend | Enables capability policy decision caching. Configure `provider` (`memory` or `redis`), `ttlSeconds`, `maxEntries`, and `redis.url`/`redis.keyPrefix` when using Redis. |
| `tls.enabled` | `false` | Toggle HTTPS/mTLS. Forced on when `mtls.enabled` is true. |
| `tls.secretName` | `""` | Secret with server cert/key (required when enabled; defaults to `<release>-orchestrator-mtls` when chart-managed). |
| `tls.mountPath` | `/etc/orchestrator/tls` | Mount location. |
| `tls.certFile` / `tls.keyFile` | `tls.crt`, `tls.key` | File names within the secret. |
| `tls.caFile` | `ca.crt` | CA bundle presented to clients (defaults to `ca.crt` for mTLS). |
| `tls.requestClientCert` | `true` | When enabled the orchestrator enforces mTLS. |
| `hpa.enabled` | `true` | Enables HorizontalPodAutoscaler for queue depth. |
| `hpa.min`/`max` | `2` / `10` | Replica range. |
| `hpa.targetQueueDepth` | `5` | Target messages per worker. |
| `resources` | Requests 200m/256Mi, limits 1CPU/512Mi | Adjust for workload size. |
| `podDisruptionBudget.enabled` | `true` | Generates a PodDisruptionBudget guarding orchestrator replicas during voluntary disruptions. |
| `podDisruptionBudget.minAvailable` | `1` | Minimum available pods; supports `maxUnavailable` override. |
| `requestLimits.jsonBytes` | `1048576` | Maximum JSON request body size enforced by the orchestrator (bytes). |
| `requestLimits.urlEncodedBytes` | `1048576` | Maximum URL-encoded request body size (bytes). |

## Indexer (`indexer`)

| Key | Default | Notes |
| - | - | - |
| `enabled` | `true` | Disable when using an external indexer. |
| `replicas` | `1` | LSP + semantic service. |
| `containerPort` | `7070` | Listen port for HTTP API. |
| `logLevel` | `info` | Set to `debug` for verbose logs. |
| `service.port` | `7070` | Kubernetes service port. |
| `requestLimitBytes` | `1048576` | Maximum request body size enforced by the indexer (bytes). |
| `env.RUN_MODE` | `consumer` | Switch to `enterprise` to require ACLs and DLP patterns at startup (process exits if misconfigured). |
| `env.INDEXER_DLP_BLOCK_PATTERNS` | `` | Comma-separated regexes merged with built-in detectors for keys, tokens, SSNs, credit cards, and JWTs. |
| `env.GATEWAY_MAX_REQUEST_BODY_BYTES` | `1048576` | Maximum body size accepted by the gateway; change when upstream OAuth payloads exceed the default. |
| `podDisruptionBudget.enabled` | `true` | Creates a PodDisruptionBudget for the indexer deployment. |
| `podDisruptionBudget.minAvailable` | `1` | Minimum indexer pods that must remain available (supports `maxUnavailable`). |

## Data Stores

| Component | Keys | Defaults |
| - | - | - |
| Redis | `redis.*` | In-cluster Redis with persistence disabled. Enable persistence + provide storage class for production. |
| Postgres | `postgres.*` | Single instance Postgres 15 (username/password `ossaat`). Override for managed DBs. |
| RabbitMQ | `rabbitmq.*` | Management image with guest credentials; configure secrets in production. |
| Kafka | `kafka.*` | Disabled by default; enable when `messaging.type=kafka`. |

## Observability

| Component | Keys | Notes |
| - | - | - |
| Jaeger | `jaeger.enabled` (`true`) | Deploys all-in-one collector for OTLP traces. Point orchestrator `observability.tracing.exporterEndpoint` to the service when externalizing. |
| Langfuse | `langfuse.*` | Optional analytics dashboard. Update secrets (`nextAuthSecret`, `salt`) and `publicUrl`. |

## Ingress

| Key | Default | Notes |
| - | - | - |
| `ingress.enabled` | `false` | Create ingress resources. |
| `ingress.className` | `""` | Set to your ingress controller (e.g. `nginx`). |
| `ingress.annotations` | `{}` | Additional annotations. |
| `ingress.hosts` | `example.com` | Configure hostname and path routing. |
| `ingress.tls` | `[]` | TLS certificates for ingress endpoints. |

## Configuration Overrides

- Pass additional environment variables using `gatewayApi.env` or `orchestrator.env` (maps rendered into `env:` blocks).
- Provide ConfigMaps/Secrets via `envFrom` or `extraVolumes` by extending the chart in an overlay chart.
- When switching to managed services (Kafka, Postgres, Redis), disable the built-in component (`enabled: false`) and configure the orchestrator via `config.yaml` or environment overrides to point to the external endpoints.

