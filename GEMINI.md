# OSS AI Agent Tool - Gemini Context

## Project Overview
**OSS AI Agent Tool** is a multi-agent coding assistant system. It features a microservices architecture with a desktop GUI, CLI, and several backend services.

## Verified Tech Stack & Architecture
*   **Frontend (GUI):** Svelte, Tauri, TypeScript (`apps/gui`)
*   **Gateway API:** Go (gRPC/HTTP) (`apps/gateway-api`)
*   **Orchestrator:** Node.js, TypeScript, Express (`services/orchestrator`)
    *   Uses **RabbitMQ** and **Kafka** for messaging (adapters found in `src/queue`).
    *   Uses **gRPC** for internal communication (`src/grpc`).
    *   **Agents** are defined via Markdown files with YAML frontmatter (e.g., `agents/planner/agent.md`).
*   **Indexer:** Rust (`services/indexer`)
    *   Uses `tree-sitter` for code parsing.
    *   Uses `candle` and `sqlx` for ML/embeddings and database interactions.
*   **CLI:** Node.js, TypeScript (`apps/cli`)

## Directory Structure & Roles
*   `agents/` - Configuration and prompt definitions for various agents (Planner, Code Writer, etc.).
*   `apps/`
    *   `cli/` - Command-line interface (`aidt`).
    *   `gateway-api/` - API Gateway handling auth and routing.
    *   `gui/` - Desktop application.
*   `services/`
    *   `indexer/` - Codebase indexing and semantic search.
    *   `orchestrator/` - Core logic, agent coordination, and queue management.
*   `charts/` - Helm charts for Kubernetes.
*   `scripts/` - Utility scripts (contains `logger.js`).

## Verified Development Commands

### Building
*   **Docker:** `docker compose -f compose.dev.yaml up --build`
*   **Make:**
    *   `make build` (Builds Gateway, Orchestrator, Indexer images)
    *   `make build-gateway-api`
    *   `make build-orchestrator`
    *   `make build-indexer`

### Testing (Per Service)
*Note: There is no global test script in `scripts/`. Tests must be run per service.*

**Gateway API (`apps/gateway-api`)**
*   Framework: Go `testing`
*   Command: `go test ./...`
*   Coverage: `make test-coverage`

**Orchestrator (`services/orchestrator`)**
*   Framework: **Vitest**
*   Command: `npm test`
*   E2E: `npm run test:e2e`
*   Coverage: `npm run test:coverage`

**Indexer (`services/indexer`)**
*   Framework: **Cargo**
*   Command: `cargo test`
*   Lint: `cargo clippy`

**CLI (`apps/cli`)**
*   Framework: Node.js native runner
*   Command: `npm test` (Builds and runs `node --test tests/*.test.js`)

**GUI (`apps/gui`)**
*   Framework: **Vitest** (Unit) & **Playwright** (E2E)
*   Unit Tests: `npm run test:unit`
*   E2E Tests: `npm run test:e2e`

## Best Practices

### Mandatory Development Workflow
When editing code, you **MUST** follow this cycle:
1.  **Edit Code & Comment:** Implement changes. **Add comments explaining 'why' complex logic exists, not just 'what' it does.**
2.  **Update Architecture:** If modifying data flows, system boundaries, or dependencies, update the relevant files in `docs/architecture/` immediately.
3.  **Create/Update Tests:** Every code change must be accompanied by a unit or integration test. **No code changes without verification.**
4.  **Verify Tests Pass:** Run tests locally to ensure correctness (`go test`, `npm test`, `cargo test`).
5.  **Check Coverage:** Aim for a minimum of 85% test coverage. Verify local coverage reports.
6.  **Lint & Format:** Run project-specific linters to match CI standards.
7.  **Update Public Documentation:** If functionality changes, update relevant `README.md` files, API specs, and user guides.

### Code Quality & Standards
*   **Linting Commands:**
    *   **Go:** `gofmt -l .` and `go vet ./...` (apps/gateway-api).
    *   **Rust:** `cargo fmt --all` and `cargo clippy` (services/indexer).
    *   **TypeScript:** `npm run lint` (services/orchestrator, apps/gui, apps/cli).
    *   *(Note: If `make` is available, use `make lint` targets defined in the root Makefile).*
*   **Type Safety:** `tsc --noEmit` is run in CI. Ensure your TypeScript changes compile without errors.

### Documentation Standards
*   **Inline Comments:** Focus on **intent**. Explain *why* a specific algorithm or workaround was chosen. Assume the reader understands the syntax but lacks the context.
*   **Architecture Docs:** The `docs/architecture/` directory is the source of truth. If you introduce a new queue, service connection, or major component, you **must** update the corresponding diagram or text description.
*   **READMEs:** Service-level `README.md` files must track configuration changes (`.env` variables, flags).

#### Directory Map
Adhere to the following organization in `docs/`:
*   `architecture/`: System design, data flow, and component diagrams.
*   `runbooks/`: Operational guides, incident response, and troubleshooting steps.
*   `compliance/`: Security reviews, system cards, and regulatory docs.
*   `reference/`: API specs, CLI command references, and configuration tables.
*   `agents/`: General agent framework docs (specific agent profiles live in `agents/<name>/`).
*   `reviews/`: Post-mortem analysis and milestone reviews.

### Testing Strategy
*   **Unit Tests:** Write deterministic unit tests for all new logic. Avoid external dependencies (mock DBs/APIsw).
*   **Integration Tests:** Use the provided dockerized infrastructure (RabbitMQ/Kafka/Postgres) for integration tests in the Orchestrator (`npm run test -- PlanQueueRuntime.rabbitmq`).
*   **Coverage Target (85%):** Aim for a minimum of **85%** test coverage across all services.
    *   **Go:** For `apps/gateway-api`, run `make test-coverage-filtered` then `go tool cover -html=coverage-filtered.out` to generate a report.
    *   **Rust:** For `services/indexer`, use `cargo llvm-cov --lcov --output-path lcov.info` then `genhtml lcov.info --output-directory target/cov-html` to generate a report (requires `cargo-llvm-cov` and `genhtml`).
    *   **TypeScript/Node:** For Orchestrator, CLI, GUI, use `npm run test:coverage` and consult the console output or generated HTML reports.

### Architecture Patterns
*   **Agents:** New agents should be defined in `agents/` using the Markdown/YAML format. Logic should be implemented in the Orchestrator `src/agents` directory only if it requires new capabilities.
*   **Messaging:** When working on the Orchestrator's "outer loop", ensure you verify functionality against *both* RabbitMQ and Kafka using the respective adapters.
*   **Protocols:** Respect the gRPC "inner loop" vs. Message Queue "outer loop" distinction defined in the architecture.

### Security
*   **Secrets:** Never commit `.env` files or credentials. Use `env.example` as a template.
*   **Dependencies:** Review `package.json` and `Cargo.toml` changes carefully to avoid introducing vulnerable packages.

### License Compliance
To ensure the project remains open-source friendly and safe for business adoption:
*   **Project License:** The root project is **Apache 2.0**.
*   **Acceptable Licenses:** When adding dependencies, prioritize permissive licenses: **Apache 2.0**, **MIT**, **ISC**, **BSD-2-Clause**, **BSD-3-Clause**, and **0BSD**.
*   **Restricted Licenses:** **Avoid** strong copyleft licenses (e.g., **GPL**, **AGPL**) or non-commercial licenses (e.g., CC-BY-NC).
*   **Compliance Tooling:**
    *   Run `node scripts/generate-compliance-report.js` to update the SBOM and compliance report.
    *   **Artifacts:**
        *   `SBOM.json`: Machine-readable inventory of all dependencies.
        *   `LICENSE_COMPLIANCE.md`: Status report flagging any restricted licenses.
*   **Manifest Alignment:** Ensure `package.json` and other package manifests reflect the correct licensing or are compatible with the root license.
