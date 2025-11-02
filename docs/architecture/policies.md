# Capability Policy Framework

This document explains how the orchestrator uses Open Policy Agent (OPA) to enforce capability-scoped authorization across plan execution and HTTP entry points.

## Overview

- Policies live in `infra/policies/capabilities.rego` and implement the rules described in `AGENTS.md` (capabilities, approvals, run modes).
- The policy is compiled to WebAssembly and evaluated inside the orchestrator via `PolicyEnforcer`.
- Enforcement happens in three places:
  - Plan submission: each step is checked before it is enqueued.
  - Human approvals: approvals record capability grants and are validated before dispatch.
  - Runtime dispatch: every tool execution is re-evaluated to detect mid-flight changes (e.g., approval revoked).

## Building the Policy Bundle

```bash
make opa-build
```

The helper script `infra/policies/build.js` wraps the `opa build` command and extracts:

- `infra/policies/dist/capabilities.wasm`
- `infra/policies/dist/data.json` (if present)

The generated directory is ignored by git (`infra/policies/dist/`). Embed the artefacts into release images via CI/CD.

## Runtime Configuration

`PolicyEnforcer` looks for a bundle in the following order:

1. `OPA_POLICY_WASM_PATH` (environment variable)
2. `./policies/capabilities.wasm` (relative to process working dir)
3. `services/orchestrator/policies/capabilities.wasm`
4. `infra/policies/dist/capabilities.wasm` (dev fallback)

Optional data can be provided via `OPA_POLICY_DATA_PATH`; if omitted, `data.json` alongside the WASM file is loaded when present.

Relevant environment variables:

- `OPA_POLICY_WASM_PATH`: absolute path to the compiled WASM bundle.
- `OPA_POLICY_DATA_PATH`: path to policy data JSON (optional).
- `RUN_MODE`: influences policy evaluation (`consumer` vs `enterprise`).

## Enforcement Flow

- Agent profiles (`agents/<name>/agent.md`) provide declared capabilities and approval rules.
- `PlanStateStore` persists approval metadata per step for subsequent evaluations.
- HTTP routes (`/plan`, `/plan/:id/steps/:stepId/approve`, `/chat`) call `PolicyEnforcer.enforceHttpAction` to ensure callers have the required capabilities.
- Queue workers call `enforcePlanStep` prior to dispatching tool invocations.

If the policy denies an action, the orchestrator surfaces structured reasons (`missing_capability`, `approval_required`, `run_mode_mismatch`) that are emitted on plan events and HTTP responses.

## Testing

- Unit tests for `PolicyEnforcer` live in `services/orchestrator/src/policy/PolicyEnforcer.test.ts` and mock the OPA runtime to validate inputs/outputs.
- Integration tests cover approval workflows and runtime enforcement via `PlanQueueRuntime.integration.test.ts`.
- When modifying policies, add regression tests that cover new rules to keep the WASM contract stable.

## Operational Checklist

- [ ] Rebuild the policy bundle (`make opa-build`) after changing Rego rules.
- [ ] Publish the updated bundle with the orchestrator artefacts (Docker image, Helm chart).
- [ ] Update policy documentation in this file and `infra/policies/README.md` with notable rule changes.
- [ ] Run `npm test` in `services/orchestrator` to execute policy/unit integration suites.

