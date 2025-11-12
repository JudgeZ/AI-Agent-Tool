# OSS AI Agent Tool

[CI](https://github.com/OSS-AI-Agent-Tool/OSS-AI-Agent-Tool/actions/workflows/ci.yml)
[Release Images](https://github.com/OSS-AI-Agent-Tool/OSS-AI-Agent-Tool/actions/workflows/release-images.yml)
[Release Helm Charts](https://github.com/OSS-AI-Agent-Tool/OSS-AI-Agent-Tool/actions/workflows/release-charts.yml)
[Security Scans](https://github.com/OSS-AI-Agent-Tool/OSS-AI-Agent-Tool/actions/workflows/security.yml)

Local-first, auditable, multi-agent coding assistant with a desktop GUI.

- **Reliability**: gRPC “inner loop” + MQ “outer loop”, idempotent jobs, SSE streaming.
- **Security**: OAuth 2.1 + PKCE, cert-manager managed mTLS between services, least-privilege capabilities (MCP), sandboxed tools, OPA approvals, OTel traces.
- **Performance/Cost**: Prompt caching, hybrid context engine, queue-based autoscaling.
- **Modes**: Consumer (single-user, local-first) and Enterprise (multi-tenant, K8s).

## Quick start (dev)
```bash
cp env.example .env
docker compose -f compose.dev.yaml up --build
```

The development Compose file builds the in-repo services and starts the full dependency stack:

| Service | Container command | Notes |
| --- | --- | --- |
| `gateway` | `/gateway-api` | Waits on the orchestrator container before accepting requests. |
| `orchestrator` | `node dist/index.js` | Requires Redis, Postgres, RabbitMQ, and Kafka to be reachable. |
| `indexer` | `/app/indexer` | Independent Rust service providing repository insights. |
| `redis` | Image default (`redis-stack-server`) | Provides cache + vector store features consumed by the orchestrator. |
| `postgres` | Image default (`docker-entrypoint.sh postgres`) | Backing relational datastore for orchestrator + Langfuse. |
| `rabbitmq` | Image default (`docker-entrypoint.sh rabbitmq-server`) | Message queue for the outer loop. |
| `kafka` | Image default (`/opt/bitnami/scripts/kafka/run.sh`) | Kafka (KRaft mode) for event fan-out. |
| `jaeger` | Image default (`/go/bin/all-in-one`) | OTLP collector and UI for traces. |
| `langfuse` | Image default (`docker-entrypoint.sh start`) | Observability dashboard for LLM interactions. |

Visit [Docker Quickstart](./docs/docker-quickstart.md) for credentials, health checks, and optional profiles.

## New: Consumer ↔ Enterprise flexibility
- Message bus: **RabbitMQ** or **Kafka** (toggle in Helm values).
- Providers: **OpenAI, Anthropic, Google, Azure OpenAI, AWS Bedrock, Mistral, OpenRouter, Local (Ollama)**.
- Auth: **API keys** and **OAuth** (where supported). See `docs/model-authentication.md`.

## Agent profiles
Create per-agent guides under `agents/<name>/agent.md` or via CLI:
```bash
npm install --workspace apps/cli
npm --workspace apps/cli run build
./node_modules/.bin/aidt new-agent planner
```

See: `docs/agents/README.md`, `docs/consumer-enterprise-modes.md`, `docs/planner.md`.

## FAQ & Troubleshooting
- Common fixes and coverage tips live in [`docs/faq-troubleshooting.md`](./docs/faq-troubleshooting.md).
- Contribution process: see [`CONTRIBUTING.md`](./CONTRIBUTING.md).
- Code of conduct: see [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
- Looking for your first task? See [`docs/good-first-issues.md`](./docs/good-first-issues.md).

## Oncall Runbooks
- Gateway/API incidents: [`docs/runbooks/gateway-api.md`](./docs/runbooks/gateway-api.md)
- Orchestrator queue/policy incidents: [`docs/runbooks/orchestrator.md`](./docs/runbooks/orchestrator.md)
- Indexer ingestion incidents: [`docs/runbooks/indexer.md`](./docs/runbooks/indexer.md)
