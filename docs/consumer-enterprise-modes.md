# Consumer vs Enterprise Modes

This app runs in **consumer** (single-user, local-first) and **enterprise** (multi-tenant, centralized) modes.

## Consumer
- **Runtime**: Tauri desktop + local services via Docker Compose.
- **Auth**: API keys (stored locally) and OAuth for providers that support consumer OAuth (e.g., Google, OpenRouter).
- **Messaging**: default **RabbitMQ** (lightweight). Kafka will ship with the enterprise adapter (Phase 3), so RabbitMQ is the only runtime queue today.
- **Secrets**: encrypted local keystore (OS keychain or file-based with passphrase).
- **Queue adapter knobs**: provide RabbitMQ URL via `RABBITMQ_URL` (default `amqp://guest:guest@localhost:5672`); tune prefetch with `RABBITMQ_PREFETCH`; control retry backoff with `RABBITMQ_RETRY_DELAY_MS`.

## Enterprise
- **Runtime**: Kubernetes with Helm; multi-tenant orchestrator.
- **Auth**:
  - OIDC (SSO for users), OAuth/OIDC, or provider-native auth for model providers.
  - Multi-tenant deployments declare GUI/Tauri client registrations through `OIDC_CLIENT_REGISTRATIONS`, a JSON array of `{ "tenant_id": "acme", "app": "gui", "client_id": "tenant-client", "redirect_origins": ["https://ops.acme.example"] }` records. Omit `redirect_origins` to allow any redirect (useful during bring-up) or provide at least one origin to restrict callbacks.
  - The gateway enforces PKCE, validates the requested `redirect_uri` against the registered origins, and requires a `session_binding` token when the registration sets `session_binding_required=true` (recommended for desktop/Tauri shells). Requests for tenants/apps without registrations are rejected when any registrations exist.
  - GUI/Tauri clients call `/auth/oidc/authorize?client_app=gui|tauri&session_binding=<token>`, and the callback page echoes the binding in the query string so the opener can confirm the login belongs to its ephemeral session.
  - Session binding tokens remain in memory/session storage and never persist beyond the current browser/Tauri session.
- **Messaging**: RabbitMQ for now; Kafka support lands with the Phase 3 queue adapter. PLAN_STATE snapshots keep steps durable while Kafka work is underway.
- **Secrets**: HashiCorp Vault by default (run mode automatically switches from `localfile` → `vault` unless overridden); **CMEK** per tenant; audit logging + OTel traces.
- **Compliance**: DPIA, data retention, system cards, SBOMs, signed releases.
- **Queue adapter knobs**: wire RabbitMQ through `RABBITMQ_URL`. Kafka values will be documented alongside the adapter delivery; prefetch and retry delay env vars tune worker concurrency/latency; completions must post to `plan.completions` queue with the same idempotency key.

## Switching modes
Set `RUN_MODE=consumer|enterprise`. Behavior differences:
- Secrets backend (`LocalFileStore` vs `VaultStore`).
- Messaging implementation injected at runtime (Kafka will replace RabbitMQ automatically once the adapter lands).
- OAuth callback host (desktop loopback for consumer; HTTPS domain for enterprise).

## Queue runtime overview

- **Plan submission**: orchestrator publishes each plan step to the `plan.steps` queue with idempotency keys (`<planId>:<stepId>`) to prevent duplicates. Steps that require approval emit `waiting_approval` events immediately; executable steps transition to `queued` only after the broker acknowledges the enqueue.
- **Completions**: downstream agents send status updates to the `plan.completions` queue; orchestrator acks, updates SSE history, and tracks dead-letter counts.
- **Metrics**: Prometheus gauge `orchestrator_queue_depth{queue=...}` reflects backlog; counter `orchestrator_queue_retries_total{queue=...}` increments on retries to surface saturation/poison-pill patterns.
- **Dead letters**: failures can be routed to `<queue>.dead` for operator triage; set `x-dead-letter-reason` header to annotate cause.
- **Crash resilience**: the plan runtime snapshots in-flight steps to a local keystore so restarts replay the latest `running`/`waiting_approval` state and re-emit SSE history without losing queue progress.
