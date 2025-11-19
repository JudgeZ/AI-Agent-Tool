# Comprehensive Remediation Plan

**Date:** 2025-11-18
**Status:** Planning
**Based on:** Forensic Code Review of Phase 4 & 5 Deliverables

## Executive Summary

A forensic review of the repository against the provided Phase 4 and Phase 5 remediation documents reveals that **significant progress has already been made**. Many items listed as "missing" in the review documents have been implemented.

The remaining critical gaps are focused on the **Orchestrator's Planning capability** and the **Developer Ecosystem (SDKs, VS Code Extension)**.

---

## 1. Status of Previously Identified Issues

### Phase 4: Indexer & Tools

| Issue | Status | Findings |
|-------|--------|----------|
| **Missing Local Embeddings** | ✅ **Fixed** | `services/indexer/src/embeddings.rs` implements `LocalBertProvider` using `candle-transformers`. |
| **Incomplete Temporal Layer** | ✅ **Fixed** | `services/indexer/src/temporal.rs` implements `get_symbol_at_commit` and `correlate_ci_failure` with real logic. |
| **Rigid Planner** | 🔴 **Open** | `services/orchestrator/src/plan/planner.ts` still uses a hardcoded `generatePlan` method. |
| **Missing Multi-Agent Graph** | 🔴 **Open** | The planner currently returns a linear list of steps, not a DAG. |

### Phase 5: Performance & Ecosystem

| Issue | Status | Findings |
|-------|--------|----------|
| **Real SLO Monitoring** | ✅ **Fixed** | `SLOMonitor.ts` implements real Prometheus queries via `fetch`. |
| **Performance Tests in CI** | ✅ **Fixed** | `.github/workflows/security.yml` includes a `performance-budget` job using `k6`. |
| **Multi-Arch Builds** | ✅ **Fixed** | `.github/workflows/release-images.yml` is configured for `linux/amd64,linux/arm64`. |
| **VS Code Extension** | 🔴 **Open** | `apps/vscode-extension` directory is missing. |
| **Missing SDKs** | 🟡 **Partial** | `packages/sdk` (TypeScript) exists. Go and Rust SDKs are missing. |

---

## 2. Remediation Action Plan

### Priority 1: Orchestrator Intelligence (Critical)

The current planner is a placeholder. To meet Phase 4 requirements, we must implement a real LLM-based planner.

*   **Task 1.1: LLM Planner Agent**
    *   **File:** `services/orchestrator/src/plan/planner.ts`
    *   **Action:** Replace the hardcoded `generatePlan` with a call to the configured LLM provider via `ProviderRegistry`. This must support all registered providers (OpenAI, Anthropic, Google, Azure, Local/Ollama, etc.) based on user configuration.
    *   **Requirement:** The prompt must be aware of available tools (from `ToolRegistry`) and generate a logical sequence of steps.

*   **Task 1.2: DAG Support**
    *   **File:** `services/orchestrator/src/plan/validation.ts` & `planner.ts`
    *   **Action:** Ensure the `PlanStep` schema supports dependencies (already present in code: `dependencies: string[]`).
    *   **Action:** Update the execution engine (likely `PlanQueueRuntime` or similar) to execute steps in parallel where possible based on dependencies.

### Priority 2: Developer Ecosystem (High)

To meet Phase 5 requirements, we need to expand the ecosystem beyond the CLI and Web UI.

*   **Task 2.1: VS Code Extension**
    *   **Location:** `apps/vscode-extension` (New)
    *   **Action:** Initialize a new VS Code extension project.
    *   **Features:**
        *   Connect to Orchestrator.
        *   "Ask Agent" command palette action.
        *   View current plan status in a sidebar view.

*   **Task 2.2: Go & Rust SDKs**
    *   **Location:** `packages/sdk-go`, `packages/sdk-rust` (New)
    *   **Action:** Generate/implement client libraries for the Orchestrator gRPC/HTTP API.
    *   **Goal:** Allow third-party tools written in Go/Rust to interact with the agent.

### Priority 3: Documentation & Cleanup (Medium)

*   **Task 3.1: Delivery Report**
    *   **Action:** Create `PHASE_5_DELIVERY_REPORT.md` summarizing the actual state of the system, highlighting the completed performance work and the pending ecosystem work.

---

## 3. Implementation Steps

1.  **Refactor Planner:** Modify `planner.ts` to use the `ProviderRegistry` to select the configured LLM provider (OpenAI, Anthropic, Google, Local, etc.) for plan generation, ensuring user choice.
2.  **Scaffold VS Code Ext:** Run `yo code` (or equivalent manual setup) in `apps/vscode-extension`.
3.  **Scaffold SDKs:** Create basic directory structure for Go and Rust SDKs.

## 4. Verification

*   **Planner:** Run a complex request (e.g., "Refactor this file and add tests") and verify the plan is not the hardcoded default.
*   **Ecosystem:** Verify the VS Code extension can connect to a running orchestrator instance.
