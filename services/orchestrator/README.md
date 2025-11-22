# Orchestrator Service

The Orchestrator is the brain of the OSS AI Agent Tool. It manages the agent lifecycle, executes plans, enforces security policies, and integrates with external model providers.

## Architecture

### Core Components
- **Controllers**: dedicated HTTP handlers in `src/controllers/` for Plan, Chat, Secrets, and Auth.
- **Plan Queue Manager**: Coordinator for the durable execution loop, managing `StepConsumer` and `CompletionConsumer`.
- **State Service**: Abstraction for persisting plan state (Postgres or File-based) and managing distributed locks.
- **Distributed Locking**: Redis-based locking ensures safe concurrent execution in multi-replica deployments.

### Dual-Loop Execution
- **Inner Loop (gRPC)**: Fast, synchronous tool execution and context retrieval.
- **Outer Loop (Queue)**: Durable, asynchronous step scheduling via **RabbitMQ** or **Kafka**.

## Key Features

- **Agent Runtime**: Loads agent profiles from `agents/*.md` and executes their capabilities.
- **Planning**: Synthesizes high-level goals into executable steps using the **Planner** agent.
- **Security**: OPA policy enforcement for capability access (`repo.write`, `network.egress`) and comprehensive audit logging.
- **Policy Enforcement**: `PolicyEnforcer` validates every sensitive action (including Chat) against OPA policies.
- **Observability**: OpenTelemetry tracing and Langfuse integration for prompt engineering.
- **Rate Limiting**: Distributed rate limiting (Redis-backed) for all external endpoints.
- **Resilient Queueing**: `PlanQueueManager` implements intelligent retries and dead-lettering for robust plan execution.

## Prerequisites

- Node.js 20+
- Redis (Cache, Rate Limiting, Distributed Locks)
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

All test commands should be run from the `services/orchestrator` directory.

```bash
# Run all fast unit tests. These should not have external dependencies.
npm test

# Run specific, long-running integration tests for the message queue runtime.
# These tests use Testcontainers to spin up ephemeral RabbitMQ or Kafka instances
# to validate the "outer loop" logic. They require Docker to be running.
# Note: These tests are valuable for ensuring adapter compatibility but run slower.
npm run test src/queue/PlanQueueRuntime.*.test.ts

# Run end-to-end tests. These may require a larger portion of the stack to be
# running or mocked.
npm run test:e2e

# Generate a test coverage report.
# The project standard is a minimum of 85% coverage, as defined in gemini.md.
# After running, view the report at ./coverage/lcov-report/index.html
npm run test:coverage
```

## Agent Profiles

Agents are defined in the `agents/` directory at the repo root. The Orchestrator loads these at startup. To add a new agent, use the CLI:

```bash
aidt new-agent <name>
```
