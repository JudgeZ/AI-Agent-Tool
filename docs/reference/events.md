# Event Schemas

This document details the event payloads published by the orchestrator. All events are validated with Zod schemas in `services/orchestrator/src/plan/validation.ts`.

## Plan Step Events

Events are emitted whenever the state of a plan step changes. They are delivered via:

- Server Sent Events (`GET /plan/:planId/events`)
- In-memory listeners registered through `subscribeToPlanSteps`

### Shape

```json
{
  "event": "plan.step",
  "traceId": "trace-c1c4c65f",
  "planId": "plan-92a390d6",
  "occurredAt": "2025-11-02T00:11:22.123Z",
  "step": {
    "id": "s2",
    "action": "apply_changes",
    "state": "waiting_approval",
    "capability": "repo.write",
    "capabilityLabel": "Apply repository changes",
    "labels": ["repo", "automation"],
    "tool": "code_writer",
    "timeoutSeconds": 300,
    "approvalRequired": true,
    "attempt": 0,
    "summary": "Awaiting security approval"
  }
}
```

### Field Notes

| Field | Type | Description |
| - | - | - |
| `event` | literal `"plan.step"` | Event channel identifier. |
| `traceId` | string | Trace correlation ID (OpenTelemetry span trace). |
| `planId` | string | Plan identifier. |
| `occurredAt` | ISO timestamp | Populated by the orchestrator when omitted. |
| `step.id` | string | Step identifier from the plan definition. |
| `step.state` | enum | One of `queued`, `running`, `retrying`, `waiting_approval`, `approved`, `rejected`, `completed`, `failed`, `dead_lettered`. |
| `step.capability` | string | Capability ID enforced via OPA policy. |
| `step.capabilityLabel` | string | Human-friendly capability label. |
| `step.labels` | string[] | Free-form labels (e.g. `repo`, `automation`). |
| `step.tool` | string | Name of the tool/agent scheduled to execute the step. |
| `step.timeoutSeconds` | number | Timeout budget for the step. |
| `step.approvalRequired` | boolean | Indicates whether human approval is required. |
| `step.attempt` | number | Retry attempt count (0-based). Present when available. |
| `step.summary` | string | Short status summary (e.g. "Awaiting confirmation"). |
| `step.output` | object | Optional tool response payload. |

### Streaming Semantics

- Events are delivered in the order they are published. Retention is capped at 200 events per plan and 5 minutes after the last terminal state.
- SSE clients should reconnect using `Last-Event-ID` to resume from the latest event.
- Terminal states (`approved`, `completed`, `failed`, `rejected`, `dead_lettered`) trigger cleanup scheduling.

## Tool Events

Tool invocation telemetry is emitted internally for queueing and retry logic.

```json
{
  "invocationId": "inv-001",
  "planId": "plan-92a390d6",
  "stepId": "s2",
  "state": "retrying",
  "summary": "Temporary network failure",
  "output": null,
  "attempt": 1,
  "occurredAt": "2025-11-02T00:15:12.456Z"
}
```

| Field | Type | Notes |
| - | - | - |
| `invocationId` | string | Unique execution attempt ID. |
| `state` | enum | Same set as plan step states. |
| `summary` | string | Optional human-readable description. |
| `output` | object | Optional structured tool output. |
| `attempt` | number | Attempt count (0 for first run). |

Tool events are persisted in the plan history alongside step events and are available through `PlanStateStore` for auditing and retries.

