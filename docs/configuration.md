# Configuration

Primary sources:
- **Environment variables** (12-factor).
- **YAML file** `config/app.yaml` (mounted via Helm ConfigMap or `.env` override in Docker Compose).

> **Quick start:** copy [`env.example`](../env.example) to `.env` and adjust the values for your environment. The example contains sane defaults for the local Compose stack and documents every variable enumerated below.

```yaml
runMode: consumer                # or enterprise
messaging:
  type: rabbitmq                 # or kafka
providers:
  defaultRoute: "balanced"       # smallest-viable model that passes evals
  enabled:
    - openai
    - anthropic
    - google
    - azureopenai
    - bedrock
    - mistral
    - openrouter
    - local_ollama
auth:
  oauth:
    redirectBaseUrl: "http://localhost:8080"  # consumer loopback
secrets:
  backend: localfile             # or vault
tooling:
  agentEndpoint: "127.0.0.1:50051" # gRPC tool runner endpoint
  retryAttempts: 3
  defaultTimeoutMs: 15000
  tls:
    insecure: true                 # optional; when false the client verifies TLS certificates
    caPaths:
      - /etc/tool-agent/ca.pem     # optional additional trust roots
    certPath: /etc/tool-agent/client.pem
    keyPath: /etc/tool-agent/client.key
network:
  egress:
    mode: enforce                  # enforce | report-only | disabled
    allow:
      - localhost
      - 127.0.0.1
      - "::1"
      - "*.svc.cluster.local"
networkPolicy:
  enabled: true
  defaultDenyEgress: true
  egressRules:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/component: jaeger
      ports:
        - protocol: TCP
          port: 4317
```

Values are merged with env vars at runtime. Invalid YAML now fails fast with a descriptive error so configuration mistakes surface immediately. See the [Docker Quickstart](./docker-quickstart.md) for local overrides and the [Kubernetes Quickstart](./kubernetes-quickstart.md) for Helm value examples.

Enterprise mode automatically promotes the secrets backend to `vault` unless you explicitly override it via file or environment variable.

### Provider routing modes

`providers.defaultRoute` controls which model providers are attempted first. The orchestrator supports the following tiers:

- `balanced` - preserves the `providers.enabled` order.
- `high_quality` - prioritises higher-accuracy clouds (`openai`, `anthropic`, `azureopenai`, `google`, `mistral`, `bedrock`, `openrouter`, then local models).
- `low_cost` - favours inexpensive/local providers (`local_ollama`, `mistral`, `openrouter`, `google`, then higher-cost clouds).

Each `/chat` request may override the routing tier (`routing`) or force a specific provider (`provider`). Provider identifiers are case-insensitive but must match `[A-Za-z0-9._-]+`; invalid names are detected and rejected as soon as a request is routed, so misconfigurations surface immediately even if the process has already started. When `provider` is supplied the orchestrator validates that the provider is enabled before dispatching the call, routes only to that provider (no fallback), and returns `404` for unknown providers. All requests may also include a validated `temperature` (0–2) that propagates to providers that support the knob (OpenAI, Azure OpenAI, Mistral, OpenRouter, etc.).

Provider-specific knobs:

- `google` – `timeoutMs` defaults to `15000` and must be a positive integer when overridden.
- `local_ollama` – `timeoutMs` defaults to `10000` and must be a positive integer when overridden.

Relevant environment overrides:

| Variable | Description |
| --- | --- |
| `RUN_MODE` | Overrides `runMode` (`consumer` vs `enterprise`). Enterprise mode toggles Vault, Kafka, and stricter approval defaults (see [Consumer vs Enterprise](./consumer-enterprise-modes.md)). |
| `TOOL_AGENT_ENDPOINT` | Host:port for the tool agent gRPC server. |
| `TOOL_AGENT_RETRIES` | Overrides retry attempts for tool execution. |
| `TOOL_AGENT_TIMEOUT_MS` | Per-call timeout in milliseconds. |
| `TOOL_AGENT_TLS_INSECURE` | When `true`, disables TLS for tool agent calls (defaults to insecure when unset). |
| `TOOL_AGENT_TLS_CERT_PATH` | Filesystem path to the client certificate presented to the tool agent. |
| `TOOL_AGENT_TLS_KEY_PATH` | Filesystem path to the private key paired with `TOOL_AGENT_TLS_CERT_PATH`. |
| `TOOL_AGENT_TLS_CA_PATHS` | Comma-separated list of CA bundle files used to validate the tool agent certificate. |
| `MESSAGING_TYPE` | Forces `rabbitmq` or `kafka` regardless of YAML setting (useful in CI matrices). |
| `MESSAGE_BUS` | Legacy alias for `MESSAGING_TYPE`. Still supported, but logs a deprecation warning and will be removed in a future release. |
| `PROVIDERS` | Comma-separated provider allow list (e.g. `openai,anthropic`). Set to an empty string to disable routing entirely. |
| `SECRETS_BACKEND` | `localfile` or `vault`; coordinates with Helm `secrets.backend` and Compose mounts. |
| `LOCAL_SECRETS_PASSPHRASE` | Required when `secrets.backend: localfile`; decrypts the local keystore. Compose seeds a development-safe default (`dev-local-passphrase`) and Helm's `values.yaml` uses a `change-me` placeholder. |
| `LOCAL_SECRETS_PATH` | Optional override for the keystore path (defaults to `config/secrets/local/secrets.json` relative to the orchestrator working directory). |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Optional overrides for Google OAuth refresh flow (defaults can also be stored in SecretsStore). |
| `GOOGLE_SERVICE_ACCOUNT` | Base64-safe JSON for Google service account credentials when running in enterprise mode. |
| `GOOGLE_API_KEY` | Direct API key fallback for Google Gemini when OAuth/service account are not available. |
| `PLAN_STATE_PATH` | Allows changing the snapshot location for inflight plan state (defaults to `data/plan-state.json`). Useful when running multiple orchestrator instances locally. |
| `RABBITMQ_URL` | Connection string for RabbitMQ (defaults to `amqp://guest:guest@localhost:5672`). Required when `messaging.type: rabbitmq`. |
| `RABBITMQ_PREFETCH` | RabbitMQ consumer prefetch count (defaults to `8`). Controls how many unacked messages each consumer can hold. |
| `QUEUE_RETRY_MAX` | Maximum retry attempts for failed plan steps (defaults to `5`). Steps exceeding this limit are moved to the dead-letter queue. |
| `QUEUE_RETRY_BACKOFF_MS` | Base delay in milliseconds for exponential backoff between retries (optional). If unset, retries occur immediately. |
| `SERVER_TLS_ENABLED` | Enables HTTPS for the orchestrator (`true`/`false`). Requires cert and key paths when enabled. |
| `SERVER_TLS_CERT_PATH` | Filesystem path to the orchestrator TLS certificate (PEM). |
| `SERVER_TLS_KEY_PATH` | Filesystem path to the orchestrator TLS private key (PEM). |
| `SERVER_TLS_CA_PATHS` | Comma-separated list of CA bundle files used to validate client certificates. |
| `SERVER_TLS_REQUEST_CLIENT_CERT` | When `true`, the orchestrator requires clients to present a TLS certificate (mTLS). Defaults to `true` when TLS is enabled. |
| `ORCHESTRATOR_TLS_ENABLED` | Enables TLS when the gateway calls the orchestrator (`true`/`false`). |
| `ORCHESTRATOR_CLIENT_CERT` | Path to the client certificate presented to the orchestrator (PEM). |
| `ORCHESTRATOR_CLIENT_KEY` | Path to the client private key associated with `ORCHESTRATOR_CLIENT_CERT`. |
| `ORCHESTRATOR_CA_CERT` | Path to the CA bundle used by the gateway to verify the orchestrator certificate. |
| `ORCHESTRATOR_TLS_SERVER_NAME` | Optional server name override for TLS verification when using IP-based URLs. |
| `OAUTH_REDIRECT_BASE` | Base URL for OAuth redirect callbacks (defaults to `http://127.0.0.1:8080`). Must match the gateway's public URL. |
| `SSE_KEEP_ALIVE_MS` | Interval in milliseconds for server-sent event keep-alive pings (defaults to `25000`). Increase or decrease based on load balancer idling behaviour. |
| `OAUTH_STATE_TTL` | Gateway OAuth state cookie TTL duration (e.g. `10m`, defaults to `10m`). |
| `ORCHESTRATOR_CALLBACK_TIMEOUT` | Gateway timeout for posting OAuth codes to the orchestrator (duration string, defaults to `10s`). |
| `OPENROUTER_CLIENT_ID` / `OPENROUTER_CLIENT_SECRET` | OpenRouter OAuth credentials when using OpenRouter provider with OAuth flow. |
| `GATEWAY_TRUSTED_PROXY_CIDRS` | Comma-separated list of CIDR ranges or individual IPs that terminate TLS in front of the gateway. Only these sources can supply `X-Forwarded-Proto`/`Forwarded` headers to mark requests as HTTPS. |
| `GATEWAY_HTTP_IP_RATE_LIMIT_WINDOW` | Rolling window for the per-IP global HTTP rate limiter (defaults to `1m`). Tune alongside `GATEWAY_HTTP_IP_RATE_LIMIT_MAX` so the cap matches expected burstiness, and keep it higher than the auth (`GATEWAY_AUTH_*`) and SSE (`GATEWAY_SSE_MAX_CONNECTIONS_PER_IP`) limits to avoid double-throttling trusted clients. |
| `GATEWAY_HTTP_IP_RATE_LIMIT_MAX` | Maximum number of HTTP requests allowed per client IP within the configured window (defaults to `120`; set to `0` to disable the global limiter). Applies to every route before the auth-specific buckets fire, giving you a coarse circuit breaker for the entire edge. |
| `GATEWAY_HTTP_RATE_LIMIT_WINDOW` | Backwards-compatible alias for the global HTTP window used when the IP-specific variable is unset. Defaults to `1m`; prefer the IP-specific knob so you can keep different windows for new identity types later. |
| `GATEWAY_HTTP_RATE_LIMIT_MAX` | Backwards-compatible alias for the global HTTP limit when no IP-specific value is supplied. Defaults to `120`. Keep this in sync with `GATEWAY_HTTP_IP_RATE_LIMIT_MAX` if you rely on the fallback path. |
| `GATEWAY_MAX_REQUEST_BODY_BYTES` | Maximum request payload size accepted by the gateway (defaults to `1048576`). Requests above the limit are rejected with HTTP 413. |
| `POLICY_CACHE_ENABLED` | Set to `true` to enable caching for capability policy decisions. Defaults to `false`. |
| `POLICY_CACHE_PROVIDER` | `memory` or `redis`. Redis is recommended for multi-instance deployments; memory cache is per-process. |
| `POLICY_CACHE_TTL_SECONDS` | TTL for cached decisions (defaults to `60`). Increase for more aggressive caching, decrease when policies change frequently. |
| `POLICY_CACHE_REDIS_URL` | Required when `POLICY_CACHE_PROVIDER=redis`. Standard Redis connection URL. |
| `POLICY_CACHE_REDIS_KEY_PREFIX` | Optional key prefix for Redis entries (defaults to `policy:decision`). Useful when sharing a Redis instance. |
| `POLICY_CACHE_MAX_ENTRIES` | Maximum in-memory cache entries (per process). Applies to both `memory` cache and the memory fallback used when Redis is unavailable. |
| `NETWORK_EGRESS_MODE` | `enforce`, `report-only`, or `disabled`. Determines how the orchestrator handles outbound HTTP(S) requests. |
| `NETWORK_EGRESS_ALLOW` | Comma-separated allow list of destinations (e.g. `api.internal.local,https://vault.example.com:8200`). Supports wildcards such as `*.svc.cluster.local`. |
| `EGRESS_MODE` / `EGRESS_ALLOW` / `ORCHESTRATOR_EGRESS_ALLOW` | Backwards-compatible aliases for the variables above. Prefer `NETWORK_EGRESS_*`. |
| `SERVER_REQUEST_LIMIT_JSON_BYTES` | Maximum JSON body size (bytes) accepted by the orchestrator. Defaults to `1048576`. |
| `SERVER_REQUEST_LIMIT_URLENCODED_BYTES` | Maximum URL-encoded body size (bytes) accepted by the orchestrator. Defaults to `1048576`. |
| `POSTGRES_MAX_CONNECTIONS` | Maximum pooled Postgres connections per orchestrator instance (defaults to `20`). Tune based on database capacity. |
| `POSTGRES_MIN_CONNECTIONS` | Minimum idle connections kept warm in the pool (defaults to `2`). Set to `0` to disable pre-warmed connections. |
| `POSTGRES_IDLE_TIMEOUT_MS` | How long (ms) idle Postgres connections are kept before being pruned (defaults to `30000`). |
| `POSTGRES_CONNECTION_TIMEOUT_MS` | Timeout (ms) for obtaining a connection from the pool (defaults to `5000`). |
| `POSTGRES_MAX_CONNECTION_LIFETIME_MS` | Maximum lifetime (ms) for a pooled connection before it's recycled (defaults to `1800000`, i.e. 30 minutes). |
| `POSTGRES_STATEMENT_TIMEOUT_MS` | Server-side statement timeout applied to each session (defaults to `5000`). Set to `0` to disable. |
| `POSTGRES_QUERY_TIMEOUT_MS` | Client-side query timeout enforced by the Node.js driver (defaults to `5000`). Set to `0` to disable. |
| `INDEXER_MAX_REQUEST_BODY_BYTES` | Maximum HTTP request body size (bytes) accepted by the indexer service. Defaults to `1048576`. |
| `INDEXER_AUTH_DISABLED` | Set to `1` to bypass JWT authentication (intended only for local development). When unset or `0`, the indexer requires a valid bearer token. |
| `INDEXER_JWT_HS256_SECRET` / `INDEXER_JWT_HS256_SECRET_FILE` | HMAC-SHA256 signing secret or a path to a file containing the secret. One of these is required unless `INDEXER_AUTH_DISABLED=1`. The Helm chart provisions a Kubernetes secret named `<release>-indexer-jwt` automatically when neither value is supplied. |
| `INDEXER_JWT_ISSUER` | Expected JWT `iss` claim. Defaults to the orchestrator internal URL when omitted. |
| `INDEXER_JWT_AUDIENCE` | Expected JWT `aud` claim. Defaults to `oss-ai-indexer`. |
| `SERVER_TLS_ENABLED` | Enable TLS for the orchestrator HTTP server. When `true`, `SERVER_TLS_CERT_PATH` and `SERVER_TLS_KEY_PATH` must also be set (or mounted via Helm secrets). |
| `SERVER_TLS_CERT_PATH` / `SERVER_TLS_KEY_PATH` | PEM-encoded certificate and private key paths for the orchestrator TLS listener. |
| `SERVER_TLS_CA_PATHS` | Optional comma-separated list of CA bundle paths used to validate client certificates. |
| `SERVER_TLS_REQUEST_CLIENT_CERT` | Set to `true` to enforce mutual TLS (client cert required). |
| `ORCHESTRATOR_TLS_ENABLED` | Enable TLS for the gateway → orchestrator client. Requires the client cert/key variables below. |
| `ORCHESTRATOR_CLIENT_CERT` / `ORCHESTRATOR_CLIENT_KEY` | PEM paths for the gateway client certificate and key delivered to the orchestrator. |
| `ORCHESTRATOR_CA_CERT` | Optional CA bundle path used by the gateway to validate the orchestrator certificate. |
| `ORCHESTRATOR_TLS_SERVER_NAME` | Overrides the server name (SNI) used by the gateway when connecting to the orchestrator over TLS. |
| `mtls.*` (Helm values) | `mtls.enabled=true` provisions orchestrator and gateway certificates via cert-manager. Configure `mtls.certManager.issuerRef` and optional SAN overrides. |

### Security headers

`server.securityHeaders` controls the HTTP hardening headers emitted by the orchestrator. Defaults include:

- `Content-Security-Policy`: `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
- `Strict-Transport-Security`: `max-age=63072000; includeSubDomains` (emitted for HTTPS requests)
- `X-Frame-Options`: `DENY`
- `X-Content-Type-Options`: `nosniff`
- `Referrer-Policy`: `no-referrer`
- `Permissions-Policy`: `camera=(), microphone=(), geolocation=()`
- `Cross-Origin-Opener-Policy`: `same-origin`
- `Cross-Origin-Resource-Policy`: `same-origin`
- `Cross-Origin-Embedder-Policy`: `require-corp`
- `X-DNS-Prefetch-Control`: `off`

Each header can be overridden or disabled in YAML and through environment variables. Override a value with `SERVER_SECURITY_HEADER_<NAME>` (`CSP`, `HSTS`, `XFO`, `XCTO`, `REFERRER_POLICY`, `PERMISSIONS_POLICY`, `COOP`, `CORP`, `COEP`, `XDNS_PREFETCH_CONTROL`) and disable a header entirely with `SERVER_SECURITY_HEADER_<NAME>_ENABLED=false`. HSTS is automatically omitted when the inbound request is not HTTPS; set `SERVER_SECURITY_HEADER_HSTS_REQUIRE_TLS=false` (or `strictTransportSecurity.requireTls: false`) to force the header during plain-HTTP migrations.

Egress enforcement defaults to `enforce`, with the following destinations whitelisted by default:

- Loopback addresses
- Primary API hosts for:
  - OpenAI (`api.openai.com`)
  - Anthropic (`api.anthropic.com`)
  - Mistral (`api.mistral.ai`)
  - Google Gemini (`generativelanguage.googleapis.com`)
  - OAuth token exchange (`oauth2.googleapis.com`)
  - OpenRouter (`openrouter.ai`)
  - Azure OpenAI subdomains (`*.openai.azure.com`)
  - AWS Bedrock runtime endpoints (`*.amazonaws.com`)
- Internal domains:
  - `*.svc`
  - `*.svc.cluster.local`
  - `*.example.com`

These defaults ensure that local development, model calls, OAuth token exchanges, Kubernetes service discovery, and test fixtures continue working out of the box. Extend `network.egress.allow` (or `NETWORK_EGRESS_ALLOW`) with any additional destinations such as Vault, OIDC providers, or outbound model APIs.

For any variable documented above you can also supply a corresponding `*_FILE` variant (for example `OIDC_CLIENT_SECRET_FILE` or `VAULT_TOKEN_FILE`). When present, the orchestrator reads the secret value from the referenced file path—ideal for Docker or Kubernetes secret mounts. File-based values take precedence over the plain environment variable.

When `OAUTH_ALLOW_INSECURE_STATE_COOKIE=true` is present, the gateway treats the configuration as a development-only override. Startup fails if the variable is set while `NODE_ENV=production` or `RUN_MODE=enterprise`.

Likewise, setting `COOKIE_SECURE=false` now causes the orchestrator to refuse startup when `NODE_ENV=production` or `RUN_MODE=enterprise`. In non-production consumer deployments the value is permitted but a warning is logged so operators can spot insecure cookie settings.

### Enabling mutual TLS in Kubernetes

1. Set `mtls.enabled=true` in `values.yaml` (or via `--set mtls.enabled=true`). Provide a cert-manager issuer with `mtls.certManager.issuerRef`.
2. Helm will generate `Certificate` resources and mount the resulting secrets into the orchestrator and gateway pods.
3. Optionally disable automation and supply your own secrets by setting `orchestrator.tls.secretName` and/or `gatewayApi.tls.secretName`, plus the corresponding `mountPath`/file names.
4. For non-Helm deployments, set the runtime environment variables above (`SERVER_TLS_*` on the orchestrator, `ORCHESTRATOR_*` on the gateway) and mount the certificate/key files at the configured paths.

### Policy decision cache

The orchestrator evaluates capability policies on every HTTP and plan step request. In high-throughput environments those decisions are often identical across requests (same agent, tenant, and capability). Enabling the decision cache reduces policy WASM invocations and lowers latency:

```yaml
policy:
  cache:
    enabled: true
    provider: redis           # or memory for single-node deployments
    ttlSeconds: 60            # cache hit window
    redisUrl: redis://redis.policy.svc.cluster.local:6379/2
    redisKeyPrefix: policy:decision
    maxEntries: 20000         # per-instance memory fallback capacity
```

- **Memory mode** stores decisions in-process and is the default for consumer deployments. Each orchestrator instance keeps its own cache.
- **Redis mode** shares decisions across replicas. When Redis is unreachable the cache automatically falls back to the in-process store and logs warnings instead of failing requests.
- TTL applies to both allow and deny decisions. Set a shorter TTL when policies change frequently or when approvals depend on rapidly changing context.

> **Forwarded scheme headers require trust.** When `GATEWAY_TRUSTED_PROXY_CIDRS` is unset the gateway ignores proxy scheme headers and only treats requests as secure when the incoming connection negotiated TLS directly. Configure this list with your load balancer or ingress IP ranges so OAuth state cookies remain secure when TLS is terminated upstream.

## Messaging backends

| Setting | Effect |
| --- | --- |
| `messaging.type: rabbitmq` | Enables RabbitMQ deployments in Compose/Helm; provisions queues via `infra/helm/rabbitmq`. |
| `messaging.type: kafka` | Switches outer loop to Kafka; ensure the Kafka profile is enabled in Helm and refer to the Kafka values in `charts/oss-ai-agent-tool/values.yaml`. |

RabbitMQ is the default for local development. Kafka is recommended for enterprise deployments with higher throughput or durability requirements.

## Indexer service

The Rust indexer exposes two primary interfaces:

- `POST /ast` – returns a Tree-sitter-derived AST for supported languages (`typescript`, `tsx`, `javascript`, `json`, `rust`). Example payload:

  ```json
  {
    "language": "typescript",
    "source": "const answer = 42;",
    "max_depth": 5,
    "max_nodes": 2048,
    "include_snippet": true
  }
  ```

  `max_depth`, `max_nodes`, and `include_snippet` are optional and default to safe limits. Unsupported languages return HTTP 400.

- `POST /semantic/documents` – ingests file content into the semantic store. Payloads must include a repository-relative `path` and `content`. The service enforces a maximum payload size of 512 KiB by default and returns HTTP 413 when the limit is exceeded. Adjust the ceiling with `INDEXER_MAX_CONTENT_LENGTH=<bytes>` (e.g. `INDEXER_MAX_CONTENT_LENGTH=1048576` for 1 MiB) when operating on larger files.

- LSP server (tower-lsp) – offers hover, go-to-definition, and reference lookups. It listens on `INDEXER_LSP_ADDR` (default `127.0.0.1:9257`). Override with `INDEXER_LSP_ADDR=0.0.0.0:9257` to expose the server on another interface.

### ACL and DLP controls

Before content is embedded or indexed, the service enforces basic access control and data loss prevention policies:

- `INDEXER_ACL_ALLOW` – **required** comma-separated list of path prefixes permitted for ingestion (e.g. `src/,docs/public/`). When unset the service rejects all paths, so production deployments must provide an explicit allowlist.
- `INDEXER_DLP_BLOCK_PATTERNS` – optional comma-separated list of additional regexes. These are appended to built-in checks for private keys, cloud credentials, API tokens, bearer JWTs, credit card numbers, and US Social Security numbers. Matches are rejected with HTTP 422. Invalid patterns trigger startup failure in enterprise mode; in consumer mode they are skipped with a warning.

When `RUN_MODE=enterprise`, the indexer treats the DLP configuration as mandatory. Any failure to compile built-in or custom patterns causes the process to exit during startup so that ingestion never proceeds without secret scanning. In `consumer` mode invalid custom expressions are skipped with a warning to keep local experimentation convenient, while the built-in patterns remain active in all modes.

Results from search/history endpoints automatically omit paths that violate the ACL, and history requests return HTTP 403 when the caller is not authorised for the path.

## Mutual TLS

Enable service-to-service authentication by setting the orchestrator to require client certificates and configuring the gateway with matching credentials. When deploying via Helm, the recommended path is to turn on the chart-level `mtls.enabled` flag and reference a cert-manager issuer (see [Helm values](./reference/helm-values.md#mutual-tls-mtls)). The chart will:

1. Issue server and client certificates (default secret names `<release>-orchestrator-mtls` and `<release>-gateway-orchestrator-mtls`).
2. Mount the secrets in the orchestrator and gateway pods.
3. Flip `ORCHESTRATOR_URL` to `https://` and require certificate authentication automatically.

If you manage secrets manually (e.g. external PKI), set `mtls.enabled=false`, provide `orchestrator.tls.*` and `gatewayApi.tls.*`, and mount the secrets yourself. In that scenario, ensure the following environment variables are supplied:

| Variable | Purpose |
| --- | --- |
| `SERVER_TLS_ENABLED` | Enables HTTPS for the orchestrator. |
| `SERVER_TLS_CERT_PATH` / `SERVER_TLS_KEY_PATH` | Point to the PEM-encoded server certificate and key. |
| `SERVER_TLS_CA_PATHS` | Comma-separated CA bundle files used to validate client certificates. |
| `SERVER_TLS_REQUEST_CLIENT_CERT` | `true` to enforce mTLS. |
| `ORCHESTRATOR_TLS_ENABLED` | Enables TLS for gateway→orchestrator traffic. |
| `ORCHESTRATOR_CLIENT_CERT` / `ORCHESTRATOR_CLIENT_KEY` | Client certificate and key presented by the gateway. |
| `ORCHESTRATOR_CA_CERT` | CA bundle used by the gateway to trust the orchestrator. |
| `ORCHESTRATOR_TLS_SERVER_NAME` | Optional SNI override when the orchestrator certificate does not match the service DNS name. |

When mTLS is active, ensure ingress controllers or sidecars that terminate TLS are configured to present a certificate signed by the same CA or that they proxy requests without terminating the connection.

## Network policies

Helm enables a chart-wide `

## Secrets rotation

Long-lived provider credentials (refresh tokens, API keys, service accounts) should be rotated without downtime. The orchestrator exposes a `VersionedSecretsManager` helper that wraps the existing `SecretsStore` and keeps a history of previous values. Key capabilities:

1. `rotate(key, value, { retain })` writes a new version, retains the latest `retain` copies (default 5), and keeps the plain key pointing at the active value so existing providers continue to work.
2. `promote(key, versionId)` promotes a previous version back to active, making rollback easy when a newly issued credential fails.
3. The manager persists metadata in the same backend (local keystore or Vault) so both consumer and enterprise modes share identical behaviour.
4. `clear(key)` removes all versions and metadata when a secret is intentionally retired.

### Example: rotate the OpenRouter refresh token

```ts
import { getVersionedSecretsManager } from "../providers/ProviderRegistry";

const secrets = getVersionedSecretsManager();
await secrets.rotate("oauth:openrouter:refresh_token", newToken, {
  retain: 5,
  labels: { provider: "openrouter" }
});
```

All previous values are stored under internal keys (prefixed with `secretver:`) and the metadata for each secret is tracked in `secretmeta:*`. These entries are encrypted inside the local keystore or protected by Vault according to the configured backend.

### Admin HTTP API

For automated rotations the orchestrator exposes authenticated endpoints guarded by the `secrets.manage` capability (and, when OIDC is enabled, an authenticated session):

- `GET /secrets/:key/versions` returns metadata for all stored versions without exposing secret material.
- `POST /secrets/:key/rotate` accepts `{ value: string, retain?: number, labels?: Record<string,string> }` and returns the activated version record.
- `POST /secrets/:key/promote` accepts `{ versionId: string }` to roll back to a prior value.

Clients receive the same metadata shape as the `VersionedSecretsManager`, which can be logged for audit purposes or used to orchestrate rollbacks.

### Unified error schema

All services (Gateway API, Orchestrator, Indexer) now emit the same JSON error payloads. Responses have HTTP status codes aligned with the failure and the body:

```json
{
  "code": "invalid_request",
  "message": "Request validation failed",
  "details": [
    { "path": "goal", "message": "goal is required" }
  ],
  "requestId": "f1fef12c-e1e8-4740-85b7-9dfd2845d3d2",
  "traceId": "4c3a2d9b1f7e5a6c"
}
```

- `code` – machine-readable identifier (e.g. `invalid_request`, `unauthorized`, `too_many_requests`).
- `message` – human-readable summary safe to surface to users.
- `details` – optional structured data (arrays or objects) with additional context.
- `requestId` – correlates the failure to server logs.
- `traceId` – OpenTelemetry trace identifier when available.

Clients should rely on the `code` for programmatic handling and treat `message` as a localized, non-stable string. The `details` payload is service-specific but always serialises as JSON.

When integrating new credentials (e.g. CLI helpers or admin APIs) prefer the manager over direct `SecretsStore#set` calls so rotation history is preserved automatically.