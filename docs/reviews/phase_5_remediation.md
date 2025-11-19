# Phase 5 Remediation Plan

**Date:** 2025-11-18
**Status:** 🔴 **REMEDIATION REQUIRED**

## Goal
Address critical gaps identified in the Phase 5 review to bring the project to a true "Done" state. This involves implementing missing components (VS Code Ext, SDKs), replacing mocked monitoring with real implementations, and fixing CI/CD workflows.

## 1. Performance & Monitoring Remediation

### 1.1 Real SLO Monitoring
- **Task:** Replace `SLOMonitor.ts` dummy data with actual Prometheus queries.
- **File:** `services/orchestrator/src/monitoring/SLOMonitor.ts`
- **Action:** Implement `getMetrics` to query the Prometheus HTTP API.
- **Verification:** Run local Prometheus, generate load, and verify `SLOMonitor` reports actual values.

### 1.2 Performance Tests in CI
- **Task:** Add performance budget checks to `security.yml`.
- **File:** `.github/workflows/security.yml`
- **Action:** Add a step that runs a load test (e.g., k6 or custom script) and asserts against p95 latency thresholds.

## 2. Ecosystem Remediation

### 2.1 VS Code Extension
- **Task:** Create the VS Code extension.
- **Location:** `apps/vscode-extension` (New Directory)
- **Action:**
    - Initialize new VS Code extension project.
    - Implement MCP client to communicate with Orchestrator.
    - Add basic commands (e.g., "Connect to Agent", "Run Plan").

### 2.2 Missing SDKs
- **Task:** Create Go and Rust SDKs.
- **Location:** `packages/sdk-go`, `packages/sdk-rust`
- **Action:**
    - **Go:** Generate/write Go client matching the TS SDK capabilities.
    - **Rust:** Generate/write Rust client matching the TS SDK capabilities.
    - Ensure both support the inner-loop contracts (gRPC/HTTP).

## 3. CI/CD Remediation

### 3.1 Multi-Arch Builds
- **Task:** Enable multi-arch builds in `release-images.yml`.
- **File:** `.github/workflows/release-images.yml`
- **Action:** Add `platforms: linux/amd64,linux/arm64` to the `docker/build-push-action` step and ensure QEMU is set up (already present).

## 4. Documentation Update

- **Task:** Correct the Delivery Report.
- **File:** `PHASE_5_DELIVERY_REPORT.md`
- **Action:** Update the report to reflect the actual state and the remediation work being done. Remove fabricated metrics.

## Execution Order

1.  **CI/CD Fixes:** Fix `release-images.yml` and `security.yml` first to ensure future builds are correct.
2.  **Monitoring Fix:** Implement real Prometheus queries in `SLOMonitor.ts`.
3.  **SDKs:** Scaffold and implement Go and Rust SDKs.
4.  **VS Code Extension:** Initialize and implement the extension.
5.  **Verify:** Run full suite of tests and generate a new, honest delivery report.
