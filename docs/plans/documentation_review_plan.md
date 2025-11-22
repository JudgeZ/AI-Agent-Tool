# Documentation Review Plan

**Objective:** Ensure all documentation in `docs/` (excluding `plans/`) accurately reflects the current state of the codebase, infrastructure, and configuration following recent significant development.

**Scope:**
*   `docs/agents/`
*   `docs/architecture/`
*   `docs/compliance/`
*   `docs/contributing/`
*   `docs/monitoring/`
*   `docs/reference/`
*   `docs/reviews/` (Check for obsolescence/context)
*   `docs/runbooks/`

**Excluded:** `docs/plans/`

## Phase 1: Architecture & System Design (`docs/architecture/`)
**Goal:** Verify system boundaries, data flows, and component descriptions.

1.  **Overview & Components:**
    *   **Source of Truth:** `docker-compose.prod.yaml`, `compose.dev.yaml`, `GEMINI.md`.
    *   **Check:** Do diagrams/text match the actual services deployed (Gateway, Orchestrator, Indexer, Redis, Postgres, RabbitMQ/Kafka)?
2.  **Data Flow:**
    *   **Source of Truth:** `services/orchestrator/src/queue/`, `apps/gateway-api/internal/gateway/`.
    *   **Check:** specific focus on the "Inner Loop" (gRPC) vs "Outer Loop" (Queue) descriptions.
3.  **Routing:**
    *   **Source of Truth:** `apps/gateway-api/main.go`.
    *   **Check:** Verify route definitions in `docs/architecture/routing.md` match the Go implementation.

## Phase 2: Configuration & Reference (`docs/reference/`)
**Goal:** Ensure all configuration options and API specs are up-to-date.

1.  **Configuration Reference (`docs/reference/configuration.md`):**
    *   **Source of Truth:**
        *   `apps/gateway-api/.env.example`
        *   `services/orchestrator/src/config/defaults.ts` (or equivalent)
        *   `services/indexer/config.example.toml`
    *   **Critical Check:** Ensure new security variables (e.g., `GATEWAY_COOKIE_HASH_KEY`, `GATEWAY_COOKIE_BLOCK_KEY`) are documented.
    *   **Critical Check:** Verify correct port numbers and URL environment variables.
2.  **API Specification (`docs/reference/api.md`):**
    *   **Source of Truth:** `apps/gateway-api` routes, `services/indexer/proto/indexer.proto`.
    *   **Check:** endpoints, methods, and payload structures.
3.  **CLI Reference (`docs/reference/cli.md`):**
    *   **Source of Truth:** `apps/cli/package.json` scripts, `apps/cli/src/`.
    *   **Check:** Command arguments and flags.

## Phase 3: Operational Guides (`docs/runbooks/`)
**Goal:** Validate instructions for running, testing, and troubleshooting.

1.  **Quickstarts (`docker-quickstart.md`, `kubernetes-quickstart.md`):**
    *   **Source of Truth:** `Makefile`, `docker-compose` files.
    *   **Check:** Do the startup commands actually work? Are prerequisites accurate?
2.  **Troubleshooting (`faq-troubleshooting.md`):**
    *   **Check:** Are the error messages and solutions still relevant?

## Phase 4: Security & Compliance (`docs/compliance/`)
**Goal:** Reflect recent security enhancements.

1.  **Threat Model (`threat-model.md`):**
    *   **Action:** Update to reflect the mitigation of the Open Redirect vulnerability via signed cookies.
    *   **Check:** Verify if new components (Indexer embeddings) introduced new surfaces.
2.  **Security Scanning:**
    *   **Check:** Align with `GEMINI.md` license compliance and scanner tools (`generate-compliance-report.js`).

## Phase 5: Agents Framework (`docs/agents/`)
**Goal:** Align docs with actual agent implementations.

1.  **Framework Overview:**
    *   **Source of Truth:** `services/orchestrator/src/agents/`.
    *   **Check:** Does the lifecycle description match the code?
2.  **Agent Profiles:**
    *   **Source of Truth:** `agents/*.md` (the definitions).
    *   **Check:** Do `docs/agents/` files duplicate or contradict the definitions in `agents/`? Consolidate if necessary.

## Execution Strategy
1.  **Scan:** Iterate through each folder in `docs/`.
2.  **Diff:** Compare document assertions against the "Source of Truth" files.
3.  **Update:** Edit the markdown files to correct inaccuracies.
4.  **Verify:** Ensure links between documents are valid.
