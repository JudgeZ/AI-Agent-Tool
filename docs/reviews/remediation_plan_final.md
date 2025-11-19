# Phase 5 Remediation Plan: Final

**Date:** 2025-11-18
**Status:** 🔴 **REMEDIATION REQUIRED**

## Goal
Address critical gaps identified in the Phase 5 review to bring the project to a true "Done" state. This involves wiring up the existing monitoring code, implementing the missing ecosystem components, and fixing the CI performance tests.

## 1. Performance & Monitoring Remediation

### 1.1 Wire up SLOMonitor
- **Task:** Initialize and start `SLOMonitor` in the orchestrator.
- **File:** `services/orchestrator/src/index.ts`
- **Action:**
    - Import `SLOMonitor`.
    - Instantiate it in `bootstrapOrchestrator`.
    - Ensure it starts its periodic checks.
    - (Optional) Expose its metrics via the `/metrics` endpoint if not already covered by Prometheus client.

### 1.2 Fix Performance Tests in CI
- **Task:** Make the `performance-budget` job in `security.yml` effective.
- **File:** `.github/workflows/security.yml`
- **Action:**
    - Update the job to spin up the orchestrator (and dependencies like Redis/Postgres) using `docker-compose` or a service container.
    - Update the `k6` script to hit the actual `/healthz` or `/plan` endpoint of the running service.
    - Fail the job if the SLOs are not met.

## 2. Ecosystem Remediation

### 2.1 VS Code Extension
- **Task:** Implement the VS Code extension.
- **Location:** `apps/vscode-extension`
- **Action:**
    - Implement `src/extension.ts` to activate the extension.
    - Implement an MCP client to connect to the Orchestrator.
    - Add a simple command (e.g., `ossaat.connect`) to verify connectivity.

### 2.2 Go SDK
- **Task:** Implement the Go SDK.
- **Location:** `packages/sdk-go`
- **Action:**
    - Create a `Client` struct.
    - Implement methods to call the Orchestrator API (e.g., `CreatePlan`).
    - Add a simple test.

### 2.3 Rust SDK
- **Task:** Implement the Rust SDK.
- **Location:** `packages/sdk-rust`
- **Action:**
    - Create a `Client` struct.
    - Implement methods to call the Orchestrator API.
    - Add a simple test.

## 3. Documentation Update

- **Task:** Update the Delivery Report.
- **File:** `PHASE_5_DELIVERY_REPORT.md`
- **Action:** Update the status to "Remediation in Progress" and list the pending items.

## Execution Order

1.  **Monitoring Fix:** Wire up `SLOMonitor` (Quick win).
2.  **CI Fix:** Fix `security.yml` (Ensures no regressions).
3.  **Ecosystem:** Implement SDKs and Extension (Parallelizable).
4.  **Verify:** Run the new CI job and verify it passes.
