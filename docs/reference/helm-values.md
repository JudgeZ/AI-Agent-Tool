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

## Gateway API (`gatewayApi`)

| Key | Default | Notes |
| - | - | - |
| `replicas` | `2` | Horizontal scaling for the HTTP edge. |
| `containerPort` | `8080` | Pod port. Service exposes port `80` by default. |
| `env` | `{}` | Extra environment variables. |
| `tls.enabled` | `false` | Enable when orchestrator requires mTLS. |
| `tls.secretName` | `""` | Secret containing client cert/key/CA. Required when TLS enabled. |
| `tls.mountPath` | `/etc/orchestrator/tls` | Mount location inside the pod. |
| `tls.clientCertFile` | `client.crt` | File name inside the secret. |
| `tls.clientKeyFile` | `client.key` | File name inside the secret. |
| `tls.caFile` | `ca.crt` | Optional CA bundle path. |
| `resources` | Requests 100m/128Mi, limits 500m/256Mi | Adjust for load. |

## Orchestrator (`orchestrator`)

| Key | Default | Notes |
| - | - | - |
| `replicas` | `2` | API server replicas. |
| `containerPort` | `4000` | Cluster service also defaults to `4000`. |
| `env` | `{ LOCAL_SECRETS_PATH, LOCAL_SECRETS_PASSPHRASE }` | Baseline local secrets config; override for Vault/Secrets Manager. |
| `tls.enabled` | `false` | Toggle HTTPS/mTLS. |
| `tls.secretName` | `""` | Secret with server cert/key (required when enabled). |
| `tls.mountPath` | `/etc/orchestrator/tls` | Mount location. |
| `tls.certFile` / `tls.keyFile` | `tls.crt`, `tls.key` | File names within the secret. |
| `tls.caFile` | `ca.crt` | Optional CA bundle presented to clients. |
| `tls.requestClientCert` | `true` | When enabled the orchestrator enforces mTLS. |
| `hpa.enabled` | `true` | Enables HorizontalPodAutoscaler for queue depth. |
| `hpa.min`/`max` | `2` / `10` | Replica range. |
| `hpa.targetQueueDepth` | `5` | Target messages per worker. |
| `resources` | Requests 200m/256Mi, limits 1CPU/512Mi | Adjust for workload size. |

## Indexer (`indexer`)

| Key | Default | Notes |
| - | - | - |
| `enabled` | `true` | Disable when using an external indexer. |
| `replicas` | `1` | LSP + semantic service. |
| `containerPort` | `7070` | Listen port for HTTP API. |
| `logLevel` | `info` | Set to `debug` for verbose logs. |
| `service.port` | `7070` | Kubernetes service port. |

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

