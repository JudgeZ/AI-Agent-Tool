# Orchestrator Service

The Orchestrator is the brain of the OSS AI Agent Tool. It manages the agent lifecycle, executes plans, enforces security policies, and integrates with external model providers.

## Key Features

- **Agent Runtime**: Loads agent profiles from `agents/*.md` and executes their capabilities.
- **Planning**: Synthesizes high-level goals into executable steps using the **Planner** agent.
- **Dual-Loop Architecture**:
  - **Inner Loop (gRPC)**: Fast, synchronous tool execution and context retrieval.
  - **Outer Loop (Queue)**: Durable, asynchronous step scheduling via **RabbitMQ** or **Kafka**.
- **Security**: OPA policy enforcement for capability access (`repo.write`, `network.egress`).
- **Observability**: OpenTelemetry tracing and Langfuse integration for prompt engineering.

## Prerequisites

- Node.js 20+
- Redis (Cache & Vector Store)
- Postgres (Data Store)
- RabbitMQ or Kafka (Message Bus)

## Configuration

See [`docs/reference/configuration.md`](../../docs/reference/configuration.md) for the complete environment variable reference.

## Development

### Installation

```bash
npm install
```

### Running Locally

```bash
# Ensure dependencies (Redis, Postgres, MQ) are running via Docker Compose
npm run dev
```

### Testing

```bash
# Run unit tests
npm test

# Run integration tests (requires Docker deps)
npm run test -- PlanQueueRuntime
```

## Agent Profiles

Agents are defined in the `agents/` directory at the repo root. The Orchestrator loads these at startup. To add a new agent, use the CLI:

```bash
aidt new-agent <name>
```
