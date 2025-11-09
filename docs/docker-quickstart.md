# Docker Quickstart

Use Docker Compose to run the OSS AI Agent Tool's application containers locally. The provided stack builds the orchestrator (Node.js), gateway API (Go), indexer (Rust), and memory service scaffold, and it also launches the full set of supporting dependencies (Redis, Postgres, RabbitMQ, Kafka, Jaeger, Langfuse). This mirrors the development topology defined in `compose.dev.yaml` so you can exercise flows without wiring additional containers by hand. Run `docker compose -f compose.dev.yaml config --services` if you want to confirm the service list locally.

## Prerequisites

* Docker Engine 24+
* Docker Compose Plugin (`docker compose`)
* Node.js 20+ (for local CLI usage)
* Access tokens for any external model providers you plan to exercise (see [Model Authentication](./model-authentication.md))

## 1. Clone and configure

```bash
git clone https://github.com/<owner>/OSS-AI-Agent-Tool.git
cd OSS-AI-Agent-Tool
mkdir -p config
cat <<'EOF' > config/app.yaml
runMode: consumer
messaging:
  type: rabbitmq
providers:
  defaultRoute: balanced
secrets:
  backend: localfile
EOF
```

Edit `config/app.yaml` (or set environment variables) to match your provider credentials and messaging preferences. See [Configuration](./configuration.md) for the full schema.

The orchestrator stores encrypted provider tokens at `config/secrets/local/secrets.json` (mounted as `/app/config/secrets/local/secrets.json` inside the container). `compose.dev.yaml` seeds a development-friendly passphrase (`dev-local-passphrase`) automatically. Override the passphrase and/or storage location by exporting environment variables (or by placing them in a `.env` file consumed by Compose):

```bash
# export LOCAL_SECRETS_PASSPHRASE="choose-a-strong-passphrase"
# Optional: override the keystore location
# export LOCAL_SECRETS_PATH="$(pwd)/config/secrets/local/secrets.json"
```

If the passphrase resolves to an empty string, the orchestrator container exits with `LocalFileStore requires LOCAL_SECRETS_PASSPHRASE to be set` during initialization.

Key options for local Compose:

```yaml
runMode: consumer
messaging:
  type: rabbitmq
providers:
  defaultRoute: balanced
secrets:
  backend: localfile
```

### Running behind load balancers

When the orchestrator sits behind a reverse proxy or load balancer, configure the proxy's CIDR ranges so rate limiting and SSE quotas continue to bind to the caller's real IP address. Add the trusted ranges to `config/app.yaml`:

```yaml
server:
  trustedProxyCidrs:
    - 10.0.0.0/8          # internal load balancer subnet
    - 192.168.100.0/24    # regional ingress controller
```

Alternatively, set the environment variable `SERVER_TRUSTED_PROXY_CIDRS=10.0.0.0/8,192.168.100.0/24`. Only proxies listed here can supply `x-forwarded-for` addresses; forged headers from other sources are ignored.

Expose the orchestrator to trusted web front ends by enumerating their origins. Development defaults allow `http://localhost:5173` and `http://127.0.0.1:5173`, so the SvelteKit UI works out of the box. In production, explicitly list every UI origin:

```yaml
server:
  cors:
    allowedOrigins:
      - https://ui.example.com
      - https://ops.internal.example
```

The same list can be provided via `SERVER_CORS_ALLOWED_ORIGINS=https://ui.example.com,https://ops.internal.example`. Browsers receive `Access-Control-Allow-Origin` and `Access-Control-Allow-Credentials` headers only when the request's origin matches this allowlist, keeping authentication cookies scoped to approved clients.

## 2. Start the stack

```bash
docker compose -f compose.dev.yaml up --build
```

Compose will build images for the in-repo services and then start the following containers (entrypoints reflect the effective command from `docker compose config`):

| Service | Image / build context | Entrypoint or command | Depends on | Exposed ports | Purpose |
| --- | --- | --- | --- | --- | --- |
| `gateway` | `./apps/gateway-api` → distroless | `/gateway-api` | `orchestrator` | `8080` | Serves the Gateway HTTP API with SSE endpoints. |
| `orchestrator` | `./services/orchestrator` | `node dist/index.js` | `redis`, `postgres`, `rabbitmq`, `kafka` | `4000` | Runs orchestration flows and provider integrations. |
| `indexer` | `./services/indexer` → distroless | `/app/indexer` | _n/a_ | `7070` | Provides AST/indexing APIs for repositories. |
| `memory-svc` | `node:20-alpine` | `tail -f /dev/null` | _n/a_ | _n/a_ | Development container for building the memory service. |
| `redis` | `redis/redis-stack-server:7.2.0-v9` | Image default (`redis-stack-server`) | _n/a_ | `6379` | In-memory cache and vector store. |
| `postgres` | `postgres:15-alpine` | Image default (`docker-entrypoint.sh postgres`) | _n/a_ | `5432` | Application relational datastore. |
| `rabbitmq` | `rabbitmq:3.13-management` | Image default (`docker-entrypoint.sh rabbitmq-server`) | _n/a_ | `5672`, `15672` | Message queue plus management UI. |
| `kafka` | `bitnami/kafka:3.7.0` | Image default (`/opt/bitnami/scripts/kafka/run.sh`) | _n/a_ | `9092` | Event backbone (KRaft mode). The orchestrator ships a Kafka adapter (kafkajs) that activates when `MESSAGING_TYPE=kafka` or `messaging.type: kafka`; defaults connect to `kafka:9092` and manage `plan.*` topics (`KAFKA_ENSURE_TOPICS`, `KAFKA_TOPIC_*`, `KAFKA_DEAD_LETTER_SUFFIX`). |
| `jaeger` | `jaegertracing/all-in-one:1.57` | Image default (`/go/bin/all-in-one`) | _n/a_ | `16686`, `4317`, `4318` | Observability UI and OTLP collectors. |
| `langfuse` | `langfuse/langfuse:2.14.1` | Image default (`docker-entrypoint.sh start`) | `postgres` | `3000` | LLM tracing and analytics dashboard. |

Because the application services expose health checks and `depends_on` wiring, `gateway` waits for `orchestrator`, and `orchestrator` waits for the data plane (Redis, Postgres, RabbitMQ, Kafka) before accepting work. Once `docker compose` reports the stack as running you can immediately interact with the HTTP endpoints.

> **Need a slimmer stack?** Limit the services you bring up, for example `docker compose -f compose.dev.yaml up gateway orchestrator redis postgres rabbitmq`, or create a local override file with the dependencies you require. Disable services you do not need (Kafka, Langfuse, Jaeger, etc.) in the override to mirror your target topology.

> **Environment tips:** Prefer `MESSAGING_TYPE` when overriding the message bus. The legacy `MESSAGE_BUS` variable still works but prints a deprecation warning. Setting `PROVIDERS=""` disables remote model routing so you can run with only local Ollama.

### Production Compose parity

`docker-compose.prod.yaml` runs the same application containers (`gateway`, `orchestrator`, `indexer`) plus the operational dependencies (`redis`, `postgres`, `rabbitmq`, `kafka`, `jaeger`, `langfuse`). The image tags default to `ghcr.io/yourorg/oss-ai-agent-tool/<service>:latest` and assume you have already pushed builds via CI. Health checks gate startup: `orchestrator` blocks on healthy Redis/Postgres while `langfuse` blocks on Postgres being ready. Adjust the `RUN_MODE`, secrets, and password environment variables before promoting the stack.

### Common flags

* `--detach` to run in the background.
* `--profile <name>` when you add your own Compose profiles in a local override to slim the stack further.

## 3. Verify services

Once the containers show `healthy`/`running` status, verify the local endpoints:

* Gateway health: <http://localhost:8080/healthz>
* Orchestrator plan endpoint: <http://localhost:4000/plan>
* Indexer status: <http://localhost:7070/healthz>
* RabbitMQ management UI: <http://localhost:15672> (user/pass `guest`/`guest`)
* Jaeger UI: <http://localhost:16686>
* Langfuse UI: <http://localhost:3000> (defaults seeded via `compose.dev.yaml`)

Use the CLI to generate a plan and agent skeleton:

```bash
npm install --workspace apps/cli
npx aidt plan "Ship MVP inner loop"
npx aidt new-agent reviewer
```

## 4. Develop agents locally

1. Edit `agents/<name>/agent.md` to update capabilities and guidance (see [Agents](./agents.md)).
2. Run orchestrator tests:
   ```bash
   npm test --workspace services/orchestrator
   ```
3. Tail container logs as needed:
   ```bash
   docker compose -f compose.dev.yaml logs orchestrator -f
   ```

## 5. Shut down

```bash
docker compose -f compose.dev.yaml down
```

Add `--volumes` to drop persistent data between sessions.

## Next steps

* Ready for production-like deployments? Continue with the [Kubernetes Quickstart](./kubernetes-quickstart.md).
* Need SBOMs or signed images? See [CI/CD](./ci-cd.md) for the release workflows.
* Review security mitigations in the [Threat Model](./SECURITY-THREAT-MODEL.md) before exposing services beyond localhost.
