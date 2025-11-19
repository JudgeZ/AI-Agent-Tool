# Phase 4 Remediation Plan

## 1. Indexer Service (`services/indexer`)

### Issues Identified
- **Missing Local Embeddings:** `embeddings.rs` has a placeholder for `LocalProvider` but it is not implemented. It currently returns an error.
- **Incomplete Temporal Layer:** `temporal.rs` has TODOs in `get_symbol_at_commit` and `correlate_ci_failure` where it should be extracting/parsing symbols from file content but currently returns placeholders.

### Remediation Steps
1.  **Implement Local Embedding Provider:**
    -   Add dependencies for `ort` (ONNX Runtime) or `candle` to `Cargo.toml`.
    -   Implement `LocalProvider` in `embeddings.rs` to load a local embedding model (e.g., `all-MiniLM-L6-v2`) and generate embeddings.
2.  **Complete Temporal Symbol Extraction:**
    -   In `temporal.rs`, implement the logic to parse file content using `symbol_extractor` within `get_symbol_at_commit`.
    -   Update `correlate_ci_failure` to use actual symbol data instead of placeholders.

## 2. Orchestrator Service (`services/orchestrator`)

### Issues Identified
- **Rigid Planner:** `src/plan/planner.ts` uses a hardcoded `buildSteps` function that always generates the same linear sequence (`index_repo` -> `apply_changes` -> `run_tests` -> `open_pr`). This violates requirement T4.6 which calls for a dynamic "planner -> code-writer -> tester -> auditor" flow in a fan-out/fan-in graph.
- **Missing Multi-Agent Graph Logic:** There is no implementation of the "fan-out/fan-in" execution graph. The current planner only supports a linear list of steps.

### Remediation Steps
1.  **Refactor Planner for Dynamic Plans:**
    -   Modify `createPlan` in `planner.ts` to use an LLM-based "Planner Agent" to generate steps based on the user's goal, rather than using the hardcoded `buildSteps`.
    -   Define a prompt for the Planner Agent that is aware of available tools and their capabilities.
2.  **Implement DAG Execution:**
    -   Update `Plan` and `PlanStep` schemas in `validation.ts` to support dependencies between steps (e.g., `dependsOn: ["step1", "step2"]`) to enable DAGs instead of just linear sequences.
    -   Update the execution engine (likely in `src/queue` or `src/plan`) to respect these dependencies, allowing parallel execution (fan-out) and synchronization (fan-in).
3.  **Implement Specialized Agents:**
    -   Ensure "Code Writer", "Tester", and "Auditor" are distinct logical agents (or specialized tool configurations) that can be targeted by the Planner.

## 3. Verification

### Verification Plan
-   **Indexer:** Run unit tests for `embeddings.rs` (once local provider is added) and `temporal.rs`. Verify that `get_symbol_at_commit` returns parsed symbols.
-   **Orchestrator:**
    -   Create a test case where `createPlan` is called with a complex goal. Verify that the generated plan is *not* the hardcoded default and logically addresses the goal.
    -   Verify that steps can run in parallel where appropriate (fan-out).
