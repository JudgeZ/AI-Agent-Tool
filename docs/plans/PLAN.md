# AI-Agent-Tool: Dynamic Multi-Workflow Platform & Cloud-Ready Architecture

This ExecPlan is a living document for evolving the AI-Agent-Tool repo into a dynamic, multi-workflow automation platform that supports security alert workflows, data analytics development, automation development, coding workflows, and a modern chat interface, while remaining deployable across Docker, Kubernetes, and multiple cloud/on-prem environments.

The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

If this repository includes a central `PLAN.md` file, this ExecPlan must remain consistent with the expectations in that file. Otherwise, treat this ExecPlan as the canonical design document for this effort.

---

## Purpose / Big Picture

The goal of this plan is to:

* Turn the existing orchestrator, indexer, gateway, and UI into a flexible **automation platform** that can support multiple first-class workflows:

  * **Alert workflows** with SIEM/SOAR-style alert ingestion, enrichment, actions, and agent chat.
  * **Data analytics development** with LangChain/LangGraph/DeepAgents-style capabilities and database connectivity.
  * **Automation development** in a SOAR-like interface combining agents and traditional code-based playbooks.
  * **Coding workflows** with an IDE-like interface backed by the indexer and agents.
  * **Chat workflows** in a sleek, modern conversational UI.

* Refactor the architecture for **performance, scalability, and maintainability**:

  * Replace the static planner with a **dynamic, externally-configurable planning engine**.
  * Modularize key UI components and backend services.
  * Make tests hermetic and CI-friendly.
  * Consolidate SDKs and configuration handling.

* Ensure the platform is **cloud-agnostic and deployable**:

  * First-class support for Docker and Kubernetes.
  * Interchangeable outer-loop messaging systems (RabbitMQ, NATS, Kafka, and cloud equivalents where appropriate).
  * Deployable to **AWS, GCP, Azure, on-prem, or hybrid** via configuration and infrastructure manifests rather than code changes.

A successful implementation enables a novice engineer, given only this repo and this ExecPlan, to clone the project, deploy it in a standard environment, and use all five workflows end-to-end with confidence.

---

## Progress

Use this section to track granular work. Every meaningful stopping point should result in an updated entry here, splitting partially completed items into “done” and “remaining” as needed. Include timestamps in UTC where practical.

* [ ] (YYYY-MM-DD HH:MMZ) Phase 0 – Set up `.agents` / `AGENTS.md` / ExecPlan workflow for this repo.
* [ ] (YYYY-MM-DD HH:MMZ) Phase 1 – Fix critical runtime issues and introduce the dynamic planner, session store abstraction, and modular `PlanTimeline` UI.
* [ ] (YYYY-MM-DD HH:MMZ) Phase 2 – Implement workflow-specific backend capabilities and front-end views for Alerts, Data Analytics, Automation, Coding, and Chat, plus SDK consolidation and test hardening.
* [ ] (YYYY-MM-DD HH:MMZ) Phase 3 – Implement messaging abstraction for RabbitMQ / NATS / Kafka, distributed state (Redis-backed), and horizontal scaling patterns.
* [ ] (YYYY-MM-DD HH:MMZ) Phase 4 – Performance tuning, multi-cloud K8s deployment manifests, and documentation including an architectural diagram and operator runbooks.
* [ ] (YYYY-MM-DD HH:MMZ) Final verification – End-to-end testing of all workflows in at least one cloud and one on-prem-style environment.

As work progresses, replace these coarse items with more detailed checkboxes reflecting actual commits and milestones.

---

## Surprises & Discoveries

Use this section to capture unexpected behavior, design constraints, or useful patterns you discover while implementing this plan.

* Observation: *None yet — to be filled as implementation proceeds.*
  Evidence: *N/A.*

As real discoveries occur (e.g., unexpected indexer performance characteristics, queue adapter edge cases, or subtle Svelte reactivity issues), document them here along with short evidence snippets (logs, test output, or brief code excerpts).

---

## Decision Log

Record every significant decision made while working this ExecPlan. Each entry should make it clear what was decided, why, and by whom.

* Decision: *Initial plan adopted to implement dynamic planner and workflow-specific UIs in phases rather than as a single large refactor.*
  Rationale: *Reduces risk by keeping each phase shippable and verifiable; allows early value from Alerts and Chat while deeper refactors continue.*
  Date/Author: *YYYY-MM-DD – <your-name>.*

Add entries for things like choice of Redis provider, preferred queue system in production versus development, selected state machine library (if any), and Kubernetes patterns (e.g., Helm vs. raw manifests).

---

## Outcomes & Retrospective

At major milestones and at completion, summarize what was achieved and how it compares to the original goals.

Planned target state:

* The platform supports five primary workflows: Alerts, Data Analytics, Automation, Coding, and Chat, each with a dedicated UI surface and backend building blocks.
* Workflow plans are **dynamic**, driven by external configuration (YAML/DB), with no need to redeploy for plan changes.
* The orchestrator can run multiple replicas with a shared Redis-backed session store and idempotency keys, behind a load balancer.
* Queue adapters are pluggable, with working implementations for at least RabbitMQ and NATS, plus a clear extension point for Kafka and/or cloud-native queues.
* The system runs locally via Docker Compose and in Kubernetes in at least one cloud (e.g., AWS) with documented patterns to replicate in GCP, Azure, and on-prem clusters.
* Tests are stable and hermetic in CI, with integration tests using ephemeral infra (containers) for Redis and queue systems.

Once phases are implemented, update this section with actual outcomes, gaps, and lessons learned.

---

## Context and Orientation

This section assumes the reader has just cloned the AI-Agent-Tool repository and knows nothing about its internals.

### High-level architecture

The repo is structured roughly along these lines (names based on existing paths mentioned in prior review notes; adjust for actual layout):

* `services/orchestrator/` – TypeScript/Node service that:

  * Accepts user goals and requests via HTTP/WebSockets (often through a gateway).
  * Plans and executes multi-step workflows using agents and tools.
  * Integrates with message queues via `QueueAdapter` implementations.
  * Maintains authentication sessions (`auth/SessionStore.ts`) and handles plan execution (`plan/planner.ts`, `agents/StandardPipelines.ts`, `agents/ExecutionGraph.ts`).

* `services/indexer/` – Rust service that:

  * Indexes code and other resources.
  * Exposes gRPC on port `7070` and HTTP (including health endpoints) on port `7071`.
  * Uses telemetry (`telemetry.rs`) to emit logging and tracing, with OpenTelemetry wiring present but not fully enabled.

* `apps/gateway-api/` – Gateway or API edge that:

  * Proxies user requests to the orchestrator and indexer.
  * Performs health checks against the indexer via `INDEXER_URL`, which currently defaults to the gRPC port.

* `apps/gui/` – SvelteKit-based GUI:

  * Main UI for visualizing plans and workflows.
  * Contains `src/lib/components/PlanTimeline.svelte`, currently a monolithic “God component” for plan rendering and step status.
  * Will be extended to include specialized views for alerts, analytics, automation, coding, and chat.

* `apps/cli/` – CLI application that:

  * Interacts with the orchestrator via HTTP and/or WebSockets.
  * Currently does not fully share client logic with `packages/sdk`.

* `packages/sdk/` – Shared TypeScript SDK:

  * Intended to be the canonical client for the orchestrator API.
  * Currently underused, with GUI and CLI maintaining their own fetch wrappers.

* Queue adapters and state:

  * `services/orchestrator/src/queue/*Adapter.ts` implement `QueueAdapter` variants (e.g., RabbitMQ, Kafka).
  * These adapters currently rely on in-memory maps (`inflightKeys`) for deduplication and idempotency.
  * `SessionStore.ts` currently stores sessions in memory, limiting horizontal scaling.

* Configuration and tools:

  * `services/orchestrator/src/config/loadConfig.ts` contains a large amount of manual config parsing and validation logic (~900 lines).
  * Tools such as `McpTool.ts` perform parameter validation manually, without consistent schema enforcement.

The current architecture is thoughtfully designed but has some key pain points:

* Planning logic is encoded as **static TypeScript** in `planner.ts`, requiring code changes for every new workflow or plan tweak.
* UI components like `PlanTimeline.svelte` have grown large and complex, with state management that will not scale gracefully as more workflows are added.
* Tests in `services/orchestrator` and related services rely on specific filesystem paths (e.g., `/workspace`) and live services, making them brittle in CI.
* Indexer tracing is partially configured but not fully wired to OTLP, leaving gaps in distributed tracing.
* In-memory session and dedupe stores prevent running multiple orchestrator replicas reliably.

This ExecPlan addresses all of these areas in a deliberate, phased way.

---

## Plan of Work

We will implement the changes in four major phases. Each phase remains shippable and verifiable.

### Phase 0 – Planning workflow scaffolding (optional but recommended)

1. Add `docs/` folder at the repo root, if not already present.
2. Add or update `AGENTS.md`, `CLAUDE.md` or `GEMINI.md` to describe when and how to use ExecPlans and planning documents in this repo (e.g., for large refactors, workflow additions, or infrastructure changes).
3. Place this ExecPlan into an appropriate folder, such as `docs/plans/PLAN.md`, and record its location in `AGENTS.md`, `CLAUDE.md` or `GEMINI.md`.

This phase gives agents a stable contract for how planning works in this repository.

### Phase 1 – Core stabilization and dynamic planner foundation

1. **Fix critical runtime issues:**

   * Adjust the gateway’s indexer health check so that `INDEXER_URL` (or equivalent config) points at the indexer’s HTTP port (`7071`) for health endpoints, not the gRPC port (`7070`).
   * Ensure `compose.dev.yaml` (or equivalent) exposes the HTTP port to the gateway.
   * Alternatively (if desired), add gRPC health checks in the gateway and point `INDEXER_URL` to the gRPC endpoint explicitly; choose one path and document it.

2. **Align pipeline execution with `ExecutionGraph`:**

   * In `services/orchestrator/src/agents/StandardPipelines.ts`, refactor the pipeline executor so that it uses `ExecutionGraph.registerHandler()` for each node type.
   * Ensure that all node types used in standard and dynamic pipelines have corresponding handlers registered (e.g. task execution, branching, wait states).
   * Remove or adapt any `graph.on("node:execute", ...)` style event listeners that are no longer needed, so that the runtime uses a single consistent handler registration mechanism.

3. **Enable distributed tracing in the indexer:**

   * In `services/indexer/src/telemetry.rs`, configure and install the OpenTelemetry OTLP exporter layer and integrate it into the tracing subscriber.
   * Respect `OTEL_EXPORTER_OTLP_ENDPOINT` (and other necessary env vars) so that traces flow to Jaeger or the chosen backend.
   * Verify that an end-to-end operation (e.g. indexing and plan execution) appears as a single trace with spans from both orchestrator and indexer.

4. **Introduce a dynamic planning engine:**

   * Define a plan definition schema in TypeScript, e.g. `services/orchestrator/src/plan/PlanDefinition.ts`, capturing:

     * Workflow identifier (e.g. `alerts`, `analytics`, `automation`, `coding`, `chat`).
     * Input conditions or goal patterns.
     * Steps, each specifying a node type, tool or agent, parameters, and transitions.
   * Implement a `PlanDefinitionRepository` interface with at least one concrete implementation reading from YAML or JSON files, e.g. `config/plans/*.yaml`.
   * Implement a `PlanFactory` or `PlanBuilder` in `services/orchestrator/src/plan/PlanFactory.ts` that:

     * Loads plan definitions from the repository based on a requested workflow or goal.
     * Constructs an in-memory `Plan` / `ExecutionGraph` instance with proper handlers and transitions.
   * Keep the existing static planner in place initially but route new workflows (and optionally migrated old ones) through the dynamic planner. Provide a configuration flag to toggle or gradually adopt dynamic plans.

5. **Modularize the `PlanTimeline` Svelte component:**

   * Extract a `PlanStep.svelte` component from `apps/gui/src/lib/components/PlanTimeline.svelte` that:

     * Receives the step’s data (status, label, timestamps, errors) via props.
     * Owns its local rendering logic and step-specific styles.
   * Update `PlanTimeline.svelte` to:

     * Iterate over steps and render `PlanStep` components.
     * Focus only on data orchestration (e.g. mapping plan state into a linear/graphical timeline) rather than detailed step rendering.
   * Move step-specific CSS into `PlanStep.svelte` and keep only layout-level styles in `PlanTimeline.svelte`.

6. **Abstract sessions and idempotency for horizontal scaling:**

   * Define an `ISessionStore` interface in `services/orchestrator/src/auth/SessionStore.ts` (or a nearby module) with operations such as `getSession`, `setSession`, `deleteSession`, and `listSessions` if needed.
   * Implement `RedisSessionStore` using a Redis client, and add configuration for Redis URL, database index, and TTL.
   * Wire the orchestrator to instantiate the appropriate session store (in-memory or Redis) based on configuration, defaulting to Redis for production-like environments.
   * Introduce a `DistributedDedupeService` (or similar) used by queue adapters. Implement a Redis-backed version using `SETNX` (or equivalent) with per-key TTL to track in-flight or recently processed messages.
   * Replace in-memory `inflightKeys` maps in queue adapters with calls to this shared dedupe service.

7. **Refine configuration loading and validation:**

   * Create a `config/schema.ts` in `services/orchestrator/src/config` that defines the configuration structure using a schema validation library (for example, Zod).
   * Refactor `loadConfig.ts` to:

     * Read environment variables and config files.
     * Parse them through the schema, producing a strongly typed configuration object.
     * Emit clear, early startup errors when configuration is invalid or incomplete.
   * Gradually replace ad-hoc config parsing throughout the orchestrator with imports from this config module.

8. **Improve indexer code organization and Docker builds:**

   * Introduce a `LanguageExtractor` trait in `services/indexer/src/symbol_extractor.rs` and implement it for each supported language. Replace the monolithic `match` statement with a registry or mapping from language to extractor.
   * Encapsulate SQL logic in `storage.rs` using parameterized queries or a query builder. Avoid dynamic string concatenation for query text where possible.
   * Update the indexer Dockerfile to cache dependencies: use a dummy `main.rs` pattern or split the build so that dependency layers are not invalidated by source code changes.

At the end of Phase 1, the system should run with critical bugs fixed, a dynamic planner hook in place, modular UI for plans, and a path to horizontal scaling via Redis-backed state.

### Phase 2 – Workflow surfaces and developer experience

1. **Define workflow-specific backend capabilities:**

   * Alerts workflow:

     * Add APIs and internal services for ingesting alerts (from files, webhooks, or future SIEM integrations).
     * Implement agent-driven enrichment steps (e.g., fetching logs, querying threat intel).
     * Design plan definitions (YAML) for typical alert playbooks, e.g. triage, enrichment, and recommended mitigations.
   * Data analytics workflow:

     * Implement tools for SQL/database connectivity and analytics (e.g., query execution and result summarization).
     * Define plans that map natural-language questions into database queries and visualizations.
   * Automation development workflow:

     * Provide an interface for defining and editing automation plans (e.g., via YAML files stored under `config/plans/automation/`).
     * Support both agentic steps (decision/analysis) and deterministic steps (scripts, API calls).
   * Coding workflow:

     * Integrate the indexer more tightly with the orchestrator, allowing agents to navigate and understand code.
     * Define plans that support tasks like “refactor module X,” “add workflow Y,” or “fix bug Z,” mapping them onto orchestrated steps.
   * Chat workflow:

     * Ensure there is a generic chat endpoint with optional workflow context injection (alerts context, code context, etc.) so that the chat UI can either operate standalone or in conjunction with an active plan.

2. **Implement workflow-specific front-end views:**

   * Add new Svelte routes and components under `apps/gui/src/routes` for:

     * `alerts/` – List and detail views for alerts, enrichment history, and recommended actions.
     * `analytics/` – Data exploration UI with query input, result tables, and possibly simple charts.
     * `automation/` – A SOAR-style development view for playbook/plan authoring and testing.
     * `coding/` – An IDE-like experience showing files, diffs, and agent guidance (optionally embedding a code editor).
     * `chat/` – A modern chat interface that can be reused or embedded in other views with shared styling.
   * Reuse the modular `PlanTimeline` and `PlanStep` components where applicable (e.g., showing plan execution for an alert or automation run).

3. **Refactor orchestrator controllers and introduce services:**

   * Extract business logic from `PlanController.ts` (and similar controllers) into `PlanService` or related service classes.
   * Keep controllers focused on HTTP concerns: request validation, parameter parsing, and response shaping.
   * Add unit tests for services independent of HTTP, simplifying logic testing.

4. **Improve tool input validation:**

   * For `McpTool` (and other tool base classes), add a generic type parameter representing the input schema and wire it to a Zod schema.
   * Ensure that all tool calls are validated against their schema before execution, returning clear errors when inputs are invalid.

5. **Consolidate SDK usage across CLI and GUI:**

   * Expand `packages/sdk` to cover all orchestrator endpoints used by the GUI and CLI, including:

     * Plan creation/execution.
     * Events and streaming endpoints.
     * Authentication and session management.
     * Workflow-specific endpoints (alerts, data analytics operations, etc.).
   * Refactor `apps/gui` and `apps/cli` to use `@oss-ai-agent-tool/sdk` (or the actual package name) for all API calls rather than custom fetch logic.
   * Add basic tests for the SDK to ensure compatibility with the orchestrator API.

6. **Strengthen testing and CI:**

   * Introduce test scaffolding that:

     * Ensures required directories (e.g., `/workspace` or local equivalents) exist before tests run.
     * Spins up ephemeral Redis and queue backends via `testcontainers` or similar for integration tests.
   * Update existing tests in `services/orchestrator` to use these scaffolds, eliminating spurious failures due to missing directories or non-running services.
   * Ensure that the default CI pipeline runs both unit and integration tests and fails quickly on config or environment issues.

At the end of Phase 2, the system will expose clear, dedicated experiences for the five workflows, backed by dynamic plans, with a significantly improved developer experience.

### Phase 3 – Messaging abstraction and horizontal scalability

1. **Extend `QueueAdapter` implementations:**

   * Review the existing `QueueAdapter` interface and ensure it is sufficiently general to cover:

     * RabbitMQ (existing or planned).
     * NATS.
     * Kafka.
   * Implement a `NatsAdapter` that:

     * Connects to a configured NATS cluster.
     * Publishes and subscribes messages according to existing queue semantics.
     * Uses the `DistributedDedupeService` for idempotency.
   * Optionally implement a `KafkaAdapter`, especially for high-throughput or event-sourcing use cases.
   * Ensure configuration allows selecting the adapter at runtime via environment variables, and document default choices for local dev.

2. **Harden distributed state and concurrency:**

   * Confirm that all orchestrator state required for correctness (sessions, idempotency keys, long-running plan state) is stored in Redis or a durable datastore.
   * If there are operations that must be mutually exclusive (e.g., certain indexer jobs or cross-plan actions), introduce a simple distributed locking mechanism using Redis or another coordination service.
   * Test behavior with multiple orchestrator instances running concurrently behind a load balancer.

3. **Observability and operations:**

   * Add metrics (e.g., via Prometheus or another system) for:

     * Plan execution counts and latencies.
     * Queue message throughput and failures.
     * Alert ingestion and enrichment times.
   * Ensure logs include correlation IDs or trace IDs so that cross-service operations can be followed from the gateway through the orchestrator to the indexer (and back).

At the end of Phase 3, the system should handle multiple orchestrator replicas and multiple queue backends gracefully, with solid observability.

### Phase 4 – Performance, multi-cloud deployment, and documentation

1. **Performance and load testing:**

   * Design test scenarios for:

     * High-volume alerts ingestion and enrichment.
     * Many concurrent chat sessions.
     * Multiple simultaneous automation runs and coding assistance tasks.
   * Use a load testing tool to simulate these scenarios, comparing metrics before and after key changes.
   * Optimize identified hot spots (e.g., slow queries, unnecessary re-renders in the UI, or inefficient plan execution paths).

2. **Docker and Kubernetes deployment patterns:**

   * Ensure that each service has a production-ready Dockerfile with:

     * Multi-stage builds where appropriate.
     * Efficient layer caching.
     * Correct environment variable usage for configuration.
   * Create Kubernetes manifests or Helm charts under a `deploy/` or similar directory that:

     * Define deployments, services, and ingress for orchestrator, indexer, gateway, GUI, and supporting services (Redis, message queue).
     * Support configuration via ConfigMaps and Secrets.
     * Allow toggling queue adapter choice and other environment-sensitive settings via values or overlays.
   * Document how to deploy:

     * Locally via `docker compose` (e.g., `docker compose -f compose.dev.yaml up`).
     * To Kubernetes clusters in AWS, GCP, and Azure, with notes on substituting managed services (e.g., managed Redis, managed queues) where appropriate.
     * To an on-prem Kubernetes cluster or bare-metal environment.

3. **Hybrid environment considerations:**

   * Provide guidance on running a hybrid deployment, e.g.:

     * Orchestrator and GUI on-prem with cloud-based indexer, or vice versa.
     * Clear documentation on required ingress/egress, required ports, and security considerations.
   * Ensure that network timeouts and retry strategies are configurable to tolerate WAN latencies.

4. **Documentation and diagrams:**

   * Add a high-level architecture diagram (e.g., Mermaid) showing:

     * Users, GUI, CLI.
     * Gateway, orchestrator, indexer.
     * Redis, queue adapters, databases.
     * External systems (SIEM, data warehouses, code hosts) where applicable.
   * Expand the README or `docs/` with:

     * A walkthrough for each workflow (Alerts, Analytics, Automation, Coding, Chat).
     * Clear instructions for initial setup and configuration.
     * Guidance on how to add new workflows or modify existing ones via the dynamic plan definitions.

At the end of Phase 4, the platform should be performant, observable, and deployable in diverse environments with clear documentation.

---

## Concrete Steps

This section describes a typical sequence for a contributor implementing this ExecPlan. Adjust commands to match the actual toolchain (`pnpm`, `npm`, `yarn`, `cargo`, etc.) used in the repo.

1. **Clone and baseline:**

   * Clone the repository and open it in your IDE.
   * From the repo root, install dependencies using the project’s preferred package manager.
   * Run the existing test suite (for example, `pnpm test`, `npm test`, or the documented command) to understand the current baseline and existing failures.
   * Start the dev environment (`docker compose -f compose.dev.yaml up` or the equivalent) and verify that the gateway, orchestrator, indexer, and GUI start and are reachable.

2. **Implement Phase 1 changes:**

   * Modify gateway and indexer configs to fix the health check port mismatch.
   * Refactor `StandardPipelines.ts` and `ExecutionGraph.ts` to use `registerHandler` consistently.
   * Enable OTLP tracing in the indexer’s telemetry module and verify traces via the chosen backend.
   * Introduce the dynamic planner schema, repository, and factory in the orchestrator, and wire a basic workflow to use it.
   * Extract `PlanStep.svelte` and refactor `PlanTimeline.svelte` to use it.
   * Add `ISessionStore` and `RedisSessionStore`, and replace in-memory state where appropriate.
   * Introduce the distributed dedupe service for queue adapters.
   * Refactor `loadConfig.ts` to use a typed schema and improve error messages.
   * Improve the indexer’s language extractor and storage modules; optimize the Dockerfile.

3. **Implement Phase 2 changes:**

   * Add backend endpoints and domain services for Alerts, Analytics, Automation, Coding, and Chat workflows.
   * Create workflow-specific front-end views and connect them to orchestrator endpoints via the SDK.
   * Refactor controllers into services and add tests.
   * Integrate schema-driven validation into `McpTool` and other tools.
   * Expand `packages/sdk` and refactor GUI/CLI to use it.
   * Set up hermetic test scaffolding and adjust CI to run tests reliably.

4. **Implement Phase 3 changes:**

   * Implement additional queue adapters (NATS, optionally Kafka) and expose configuration for selecting them.
   * Ensure Redis-backed state is used for all orchestrator replicas; add any necessary distributed locks.
   * Add metrics and logging improvements, confirming that they work in dev and test environments.

5. **Implement Phase 4 changes:**

   * Design and run load tests against critical workflows.
   * Analyze performance and fix bottlenecks, then re-run tests to validate improvements.
   * Finalize Dockerfiles and K8s manifests/Helm charts and test deployments in at least one cloud and one on-prem-like environment.
   * Add architecture diagrams and documentation, including workflow walkthroughs and deployment instructions.

6. **Final verification:**

   * With the full stack running (locally or in a test environment), exercise all five workflows manually:

     * Trigger alerts and confirm they are enriched, visualized, and actionable.
     * Run data analytics queries via the new interface.
     * Define and execute automation playbooks.
     * Use the coding interface to perform a non-trivial code change.
     * Chat with the agent(s) in the modern chat UI, including context-aware interactions.
   * Confirm tests pass and that new capabilities are reflected in docs.

---

## Validation and Acceptance

The plan is considered successfully implemented when:

* A new contributor can:

  * Clone the repo.
  * Follow documented setup steps.
  * Run the system locally via Docker Compose or similar.
  * Deploy the system to a Kubernetes cluster using the provided manifests.
  * Use the Alerts, Analytics, Automation, Coding, and Chat workflows with no additional tribal knowledge.

* Dynamic plans:

  * Are defined in external YAML/JSON files or a database.
  * Can be added or modified without code changes or redeploys.
  * Drive the orchestrator’s plan execution in place of (or alongside) the static planner.

* Queue systems:

  * Are selected and configured purely via configuration.
  * Support at least RabbitMQ and NATS adapters, with idempotency and deduplication functioning across orchestrator replicas.

* State:

  * Redis-backed session and dedupe services are in use for production-like deployments.
  * Orchestrator replicas can be scaled horizontally without breaking sessions or producing duplicate work.

* Observability:

  * Distributed tracing shows a unified story for events crossing gateway, orchestrator, and indexer.
  * Metrics and logs are sufficient for diagnosing issues in production.

* Tests:

  * Run cleanly in CI in a hermetic fashion, using ephemeral or mocked external dependencies.
  * Cover core workflows and components, especially dynamic planning, queue adapters, and workflow-specific surfaces.

Acceptance can be verified by running the documented test commands and manual workflows and confirming behavior matches these expectations.

---

## Idempotence and Recovery

This ExecPlan is designed so that:

* Most changes are **additive and configurable**:

  * New planner implementation and plan definitions can coexist with the old static planner until fully migrated.
  * New queue adapters can be deployed without removing the existing ones.
  * Redis-backed state can be introduced while still supporting in-memory stores for local dev.

* Refactors happen behind **feature flags** or config switches where possible:

  * For example, a `PLANNER_MODE` configuration could select between `static` and `dynamic`, allowing safe incremental rollout.
  * Queue adapter selection is driven by env vars, allowing rollback to a known-good adapter if needed.

* Migrations are safe to rerun:

  * Configuration and infrastructure changes should be written so that rerunning them does not break the system (for example, applying Kubernetes manifests multiple times, or re-running Terraform/infra scripts in a controlled environment).

If a step fails partially (for example, a new adapter misconfiguration), the rollback strategy is to:

* Revert configuration to the previous known-good values (e.g., revert queue adapter type or planner mode).
* Redeploy services to ensure they use the previous configuration.
* Only once the system is stable, reattempt the failed step with corrected configuration or code.

---

## Artifacts and Notes

As you implement this plan, consider producing and updating these artifacts:

* `docs/architecture-diagram.mmd` – Mermaid diagram showing services, data stores, and message flows.
* `docs/workflows-alerts.md`, `docs/workflows-analytics.md`, etc. – Workflow-specific guides with screenshots or example command sequences.
* `deploy/` – K8s manifests or Helm charts in a clearly documented structure.
* `config/plans/` – Versioned plan definition files, with comments explaining their purpose and usage.
* `docs/operations.md` – Runbook for operators, including how to switch queue adapters, scale orchestrator replicas, and troubleshoot common issues.

Keep this section updated with links to newly created artifacts and any notes that would help a future maintainer understand why things are organized as they are.

---

## Interfaces and Dependencies

This section summarizes the key interfaces that must exist or be introduced for the plan to work coherently.

* **Dynamic planning interfaces:**

  * `PlanDefinition` (TypeScript type) describing workflows and steps.
  * `PlanDefinitionRepository` with implementations for file-based and (optionally) database-backed definitions.
  * `PlanFactory` / `PlanBuilder` that turns definitions into executor-ready `Plan` or `ExecutionGraph` instances.

* **Queue and messaging interfaces:**

  * `QueueAdapter` interface with methods for publishing, consuming, acknowledging, and negatively acknowledging messages.
  * Concrete implementations: `RabbitMqAdapter`, `NatsAdapter`, optional `KafkaAdapter`.
  * `DistributedDedupeService` interface and `RedisDedupeService` implementation for idempotent message handling.

* **Session and state interfaces:**

  * `ISessionStore` interface and `RedisSessionStore` implementation.
  * Optional `InMemorySessionStore` for local dev and tests that do not require cross-process consistency.

* **Configuration schema:**

  * `ConfigSchema` defined in code (e.g., via Zod) capturing all orchestrator configuration (ports, URLs, queue type, Redis connection, feature flags).
  * `loadConfig()` returns a fully validated, typed config object.

* **Tool validation:**

  * `McpTool` base class extended with a typed input schema, and tool implementations that provide their own schema for validation.

* **UI components:**

  * `PlanTimeline.svelte` orchestrating display of steps and plan status.
  * `PlanStep.svelte` rendering individual steps.
  * Workflow-specific pages under `apps/gui/src/routes` (alerts, analytics, automation, coding, chat).

* **SDK:**

  * `packages/sdk` exports a stable, versioned TypeScript client interface that covers:

    * Plan management (create, execute, cancel).
    * Events/streaming, authentication, and the new workflow endpoints.
  * GUI and CLI depend on this SDK rather than re-implementing clients.

Maintaining clear, stable interfaces and documenting them ensures that future changes can be localized and that the platform will continue to evolve without becoming brittle.
