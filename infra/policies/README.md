# OPA Policies

This directory contains the capability enforcement policies used by the orchestrator.

## Contents

- `capabilities.rego` – primary authorization policy for enforcing capability scopes, approval requirements, and run-mode constraints.
- `build.js` – helper script that compiles the Rego policy into a WebAssembly bundle using the OPA CLI.
- `dist/` – generated artifacts (ignored in git) containing the compiled `capabilities.tar.gz` bundle.

## Building the Policy Bundle

1. Install the [OPA CLI](https://www.openpolicyagent.org/docs/latest/#running-opa) and ensure `opa` is on your `PATH`.
2. Run the build helper:

   ```bash
   node infra/policies/build.js
   ```

   The script outputs `dist/capabilities.tar.gz`, which includes `policy.wasm` and associated data files. This bundle is consumed by the orchestrator at runtime.

## Policy Input Contract

The policy expects input with the following shape:

```json
{
  "subject": {
    "agent": "code-writer",
    "capabilities": ["repo.read", "repo.write"],
    "approvals": { "repo.write": true },
    "run_mode": "consumer"
  },
  "action": {
    "type": "step.execute",
    "capabilities": ["repo.write"],
    "run_mode": "consumer"
  }
}
```

- The subject must present all capabilities required by the action.
- Capabilities listed in `requires_approval` (e.g., `repo.write`, `network.egress`) must have an explicit approval record.
- Optional run-mode constraints ensure that consumer agents cannot perform enterprise-only actions.

The policy returns `{ "allow": true }` when the action is permitted. When denied, the `deny` set contains structured reasons that are surfaced by the orchestrator.

