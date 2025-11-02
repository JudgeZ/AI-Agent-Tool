# Configuration

Primary sources:
- **Environment variables** (12-factor).
- **YAML file** `config/app.yaml` (mounted via Helm ConfigMap or `.env` override in Docker Compose).

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

Relevant environment overrides:

| Variable | Description |
| --- | --- |
| `RUN_MODE` | Overrides `runMode` (`consumer` vs `enterprise`). Enterprise mode toggles Vault, Kafka, and stricter approval defaults (see [Consumer vs Enterprise](./consumer-enterprise-modes.md)). |
| `TOOL_AGENT_ENDPOINT` | Host:port for the tool agent gRPC server. |
| `TOOL_AGENT_RETRIES` | Overrides retry attempts for tool execution. |
| `TOOL_AGENT_TIMEOUT_MS` | Per-call timeout in milliseconds. |
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

- LSP server (tower-lsp) – offers hover, go-to-definition, and reference lookups. It listens on `INDEXER_LSP_ADDR` (default `127.0.0.1:9257`). Override with `INDEXER_LSP_ADDR=0.0.0.0:9257` to expose the server on another interface.

### ACL and DLP controls

Before content is embedded or indexed, the service enforces basic access control and data loss prevention policies:

- `INDEXER_ACL_ALLOW` – comma-separated list of path prefixes permitted for ingestion (e.g. `src/,docs/public/`). Defaults to allowing all paths.
- `INDEXER_DLP_BLOCK_PATTERNS` – optional comma-separated list of additional regexes. These are appended to built-in checks for private keys, API tokens, and other secret markers. Matches are rejected with HTTP 422.

Results from search/history endpoints automatically omit paths that violate the ACL, and history requests return HTTP 403 when the caller is not authorised for the path.

## Mutual TLS

TLS can be enabled for internal service-to-service traffic so the gateway and other callers must present client certificates when talking to the orchestrator.

- **Orchestrator (`server.tls`)** – configure via `config/app.yaml` or environment variables listed above. When enabled, provide PEM-encoded key/cert pairs and, optionally, a CA bundle for client verification. Helm values under `orchestrator.tls` manage mounting a Kubernetes `Secret` with the required files.
- **Gateway (`gatewayApi.tls`)** – when `enabled`, the chart mounts the client certificate secret and sets `ORCHESTRATOR_TLS_*` variables so the gateway performs mutual TLS when proxying to the orchestrator.

Example Kubernetes secret creation:

```bash
kubectl create secret generic orchestrator-tls \
  --from-file=tls.crt=server.crt \
  --from-file=tls.key=server.key \
  --from-file=ca.crt=ca.pem

kubectl create secret generic orchestrator-client-tls \
  --from-file=client.crt=client.crt \
  --from-file=client.key=client.key \
  --from-file=ca.crt=ca.pem
```

Reference the secrets via `orchestrator.tls.secretName` and `gatewayApi.tls.secretName` in `values.yaml`.

## Network policies

Helm enables a chart-wide `NetworkPolicy` by default. Ingress remains namespace-scoped (allowing pods in the same namespace plus select operators), while egress is default-deny. Use the following knobs to curate outbound access:

- `networkPolicy.egressRules`: list of Kubernetes egress rule objects. The defaults allow DNS (UDP/TCP 53 to pods labelled `k8s-app: kube-dns`) and OTLP/HTTP traffic to the bundled Jaeger collector (`app.kubernetes.io/component: jaeger`, TCP 4317).
- `networkPolicy.egress` (advanced): provide a full list of egress rules to bypass the templated defaults entirely.
- `networkPolicy.defaultDenyEgress`: set to `false` to fall back to the legacy “allow all” behaviour if you deliberately need it (not recommended in production).

## Secrets backends

| Mode | Description |
| --- | --- |
| `localfile` | Encrypted JSON stored at `config/secrets/local/secrets.json` (override with `LOCAL_SECRETS_PATH`). The orchestrator creates the directory automatically; provide `LOCAL_SECRETS_PASSPHRASE` via Compose/Helm or your host environment. |
| `vault` | HashiCorp Vault integration (enabled automatically when `runMode: enterprise`). Configure `VAULT_ADDR`, `VAULT_TOKEN`, or Kubernetes auth via Helm values. |

Refer to the [Security Threat Model](./SECURITY-THREAT-MODEL.md) for mitigations tied to each backend and ensure CI includes the appropriate secret scanning rules.

Compose sets `LOCAL_SECRETS_PATH=/app/config/secrets/local/secrets.json` inside the container so encrypted tokens persist across restarts. The Helm chart exposes the same variables under `orchestrator.env`; override `LOCAL_SECRETS_PASSPHRASE` with a Kubernetes `Secret` for production workloads.

> **Notes:**
> - When the orchestrator boots with `secrets.backend: localfile` and no `LOCAL_SECRETS_PASSPHRASE` is provided, initialization fails with an explicit `LocalFileStore requires LOCAL_SECRETS_PASSPHRASE to be set` error so you can supply the passphrase before retrying.
> - Setting `providers.enabled: []` in YAML (or `PROVIDERS=""`) is respected as an intentional “no providers” configuration; the orchestrator will return a `503` instead of silently falling back to defaults.
