# Plan Tool

The **Plan Tool** produces verifiable, idempotent plans for multi-step changes and exposes them through the orchestrator HTTP API.

## Goals
- Deterministic, replayable plans with clear inputs/outputs.
- Bounded steps, timeouts, and explicit approval gates.
- Artifacts written to `.plans/<id>/{plan.json, plan.md}`.
- Stream step lifecycle events over Server-Sent Events (SSE) for UI updates.

## HTTP API

### `POST /plan`

Request body:

```json
{
  "goal": "Ship the next milestone"
}
```

Response body:

```json
{
  "plan": {
    "id": "plan-550e8400-e29b-41d4-a716-446655440000",
    "goal": "Ship the next milestone",
    "steps": [
      {
        "id": "s1",
        "action": "index_repo",
        "tool": "repo_indexer",
        "capability": "repo.read",
        "capabilityLabel": "Read repository",
        "labels": ["repo", "automation"],
        "timeoutSeconds": 300,
        "approvalRequired": false
      },
      {
        "id": "s2",
        "action": "apply_changes",
        "tool": "code_writer",
        "capability": "repo.write",
        "capabilityLabel": "Apply repository changes",
        "labels": ["repo", "automation", "approval"],
        "timeoutSeconds": 900,
        "approvalRequired": true
      }
    ],
    "successCriteria": ["All tests pass", "CI green", "Docs updated"]
  },
  "traceId": "07f1d186-4f07-4b40-9265-6a51f78fbdfa"
}
```

Each plan creation emits a `plan.step` event per step: approval-gated steps start in `waiting_approval`, while executable steps emit `queued` after the broker acknowledges their enqueue. Artifacts are written to `.plans/<id>/plan.json` and `.plans/<id>/plan.md` as part of the same request.

### `POST /chat`

Thin pass-through to the model provider registry. Example payload:

```json
{
  "messages": [
    { "role": "user", "content": "Summarize the diff." }
  ]
}
```

Successful responses include the provider response and a `traceId` that correlates with the plan and chat spans.

### `GET /plan/:id/events`

An SSE endpoint that replays existing events and streams subsequent step transitions in real-time. Clients should set `Accept: text/event-stream`.

Sample event payload:

```text
event: plan.step
data: {"event":"plan.step","traceId":"07f1d186-4f07-4b40-9265-6a51f78fbdfa","planId":"plan-550e8400-e29b-41d4-a716-446655440000","step":{"id":"s2","action":"apply_changes","tool":"code_writer","state":"waiting_approval","capability":"repo.write","capabilityLabel":"Apply repository changes","labels":["repo","automation","approval"],"timeoutSeconds":900,"approvalRequired":true,"summary":"Awaiting approval"}}
```

For test automation or scripting scenarios, sending `Accept: application/json` returns a JSON object with the accumulated events instead of holding the connection open.

Because queue enqueueing is now atomic with event emission, callers will only see `queued` once the broker accepted the message. If the enqueue fails, a `failed` event is emitted with the broker error so operators can retry.

## Step Metadata

Each step surfaces the capability it exercises, the execution timeout, and whether human approval is required:

```json
{
  "id": "s2",
  "action": "apply_changes",
  "tool": "code_writer",
  "capability": "repo.write",
  "capabilityLabel": "Apply repository changes",
  "labels": ["repo", "automation", "approval"],
  "timeoutSeconds": 900,
  "approvalRequired": true
}
```

## Observability

Every HTTP handler and plan creation call is wrapped in a lightweight tracing shim that records a `traceId`, span attributes (plan id, chat model, etc.), and structured log entries. The implementation is intentionally minimal so OpenTelemetry exporters can be layered in without changing call sites.
