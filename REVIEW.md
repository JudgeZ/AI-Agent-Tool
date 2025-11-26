# Code Review Findings

## Critical Issues (Blocking)

### 1. Gateway-Indexer Port Mismatch
**Location**: `apps/gateway-api` configuration & `services/indexer/src/server.rs`
**Issue**: The Gateway is configured to health-check the Indexer service using `INDEXER_URL` (default `http://indexer:7070`). However, `services/indexer` listens for gRPC traffic on port `7070` and HTTP traffic (including health checks) on port `7071`. This will cause health checks to fail in the default development environment.
**Remediation Plan**:
- Update `compose.dev.yaml` to expose the Indexer's HTTP port to the Gateway, or update the Gateway configuration to target port `7071` for health checks.
- Alternatively, implement gRPC health checks in the Gateway if `INDEXER_URL` is intended to be the gRPC endpoint.

### 2. Pipeline Execution Wiring Mismatch
**Location**: `services/orchestrator/src/agents/StandardPipelines.ts` vs `services/orchestrator/src/agents/ExecutionGraph.ts`
**Issue**: `StandardPipelines.ts` attempts to register node handlers using event listeners (`graph.on("node:execute", ...)`). However, the `ExecutionGraph` engine explicitly calls `this.getHandler(type).execute(...)`, which expects handlers to be registered via the `registerHandler` method. This disconnect will cause runtime errors ("No handler registered for node type") when executing dynamic pipelines.
**Remediation Plan**:
- Refactor `PipelineExecutor` in `StandardPipelines.ts` to use `graph.registerHandler(NodeType.TASK, ...)` instead of event listeners.
- Ensure all node types used in the pipelines have corresponding handlers registered.

### 3. Indexer Distributed Tracing Gap
**Location**: `services/indexer/src/telemetry.rs`
**Issue**: Although `opentelemetry` dependencies are present, the `init_tracing` function only initializes the stdout `fmt::layer`. It fails to initialize the OTLP exporter layer, meaning Indexer traces will not be sent to Jaeger, breaking distributed tracing visibility for indexing operations.
**Remediation Plan**:
- Update `telemetry.rs` to configure and install the `tracing-opentelemetry` layer with the OTLP exporter, ensuring it respects the `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable.

---

## Suggestions (Non-blocking)

### 1. Session & State Persistence (Scalability)
**Location**: `services/orchestrator/src/auth/SessionStore.ts`, `services/orchestrator/src/queue/*Adapter.ts`
**Issue**: The `SessionStore` and Queue Adapters (`inflightKeys`) use in-memory data structures. This prevents horizontal scaling (multiple orchestrator replicas) and causes state loss (sessions, idempotency data) on restarts.
**Remediation Plan**:
- **Sessions**: Extract an `ISessionStore` interface and implement `RedisSessionStore`. Configure the application to switch based on environment.
- **Idempotency**: Implement a `DistributedDedupeService` backed by Redis (using `SETNX` with TTL) and inject it into the RabbitMQ/Kafka adapters.

### 2. Configuration & Validation Refactoring
**Location**: `services/orchestrator/src/config/loadConfig.ts`, `services/orchestrator/src/tools/McpTool.ts`
**Issue**: Configuration loading relies on verbose, manual parsing logic (~900 lines). Tool input validation uses a basic manual check.
**Remediation Plan**:
- **Config**: Refactor `loadConfig.ts` to use `zod` for schema definition, parsing, and validation. This will significantly reduce code size and improve robustness.
- **Tools**: Integrate `zod` into the `McpTool` base class generics to provide automatic, schema-driven input validation for all tools.

### 3. SDK Consolidation
**Location**: `packages/sdk`, `apps/cli`, `apps/gui`
**Issue**: The `packages/sdk` library is currently unused. Both the CLI and GUI applications implement their own API clients for the Orchestrator, leading to code duplication and potential API drift.
**Remediation Plan**:
- Update `packages/sdk` to cover all necessary Orchestrator endpoints (Plan, Auth, Events).
- Refactor `apps/cli` and `apps/gui` to consume `@oss-ai-agent-tool/sdk` instead of maintaining custom fetch wrappers.

### 4. Indexer Code Quality
**Location**: `services/indexer`
**Issue**:
- `symbol_extractor.rs` uses a monolithic match statement for language support.
- `storage.rs` uses raw, dynamically constructed SQL strings.
- `Dockerfile` does not optimize for layer caching (rebuilds dependencies on source changes).
**Remediation Plan**:
- **Extraction**: Refactor symbol extraction into a polymorphic `LanguageExtractor` trait.
- **Storage**: Adopt a DAO pattern or query builder to encapsulate SQL logic and improve safety.
- **Docker**: Use the "dummy main.rs" pattern in the Dockerfile to cache cargo dependency builds.

### 5. Orchestrator Architecture
**Location**: `services/orchestrator`
**Issue**:
- `PlanController.ts` contains mixed business logic (policy, rate limiting).
- `PlanTimeline.svelte` (Frontend) manages complex async state manually.
**Remediation Plan**:
- **Controller**: Extract a `PlanService` to handle business logic, leaving the controller to handle HTTP concerns.
- **Frontend**: Refactor `planTimeline` store to use a formal State Machine (e.g., XState) for predictable connection and step lifecycle management.
