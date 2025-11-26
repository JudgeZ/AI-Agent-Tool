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

## Dynamic Planning Engine (Phase 1)

The orchestrator now supports a **dynamic planning engine** that loads workflow definitions from external YAML files, allowing operators to modify plans without code changes.

### Plan Definition Structure

Plans are defined in `config/plans/*.yaml` with the following structure:

```yaml
schemaVersion: "1.0.0"
plans:
  - id: unique-plan-id
    name: Human-readable Plan Name
    description: |
      Multi-line description of what this plan does.
    version: "1.0.0"
    workflowType: coding  # alerts | analytics | automation | coding | chat
    inputConditions:
      - type: keywords     # Match if goal contains these keywords
        value: refactor,cleanup,optimize
        priority: 15
      - type: pattern      # Match if goal matches regex
        value: "(refactor|clean up).*code"
        priority: 20
    tags:
      - development
      - refactoring
    enabled: true
    variables:
      maxRetries: 3
      timeoutMultiplier: 1.5
    successCriteria:
      - All changes compile
      - Tests pass
    steps:
      - id: step-1
        action: analyze_code
        tool: code_analyzer
        capability: repo.read
        capabilityLabel: Analyze codebase
        labels: [analysis]
        timeoutSeconds: 300
        approvalRequired: false
        input:
          target: "${targetPath}"
      - id: step-2
        action: apply_changes
        tool: code_writer
        capability: repo.write
        dependencies: [step-1]
        approvalRequired: true
        input:
          analysis: "${step-1.output}"
```

### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `PlanDefinition.ts` | `src/plan/` | Zod schemas for validating plan definitions |
| `PlanDefinitionRepository.ts` | `src/plan/` | Interface and YAML-based repository implementation |
| `PlanFactory.ts` | `src/plan/` | Creates `ExecutionGraph` instances from plan definitions |

### Workflow Types

Five workflow types are supported, each with dedicated plan definitions:

- **alerts**: Security alert triage, enrichment, and remediation
- **analytics**: Data exploration, query execution, and visualization
- **automation**: Playbook execution and scheduled task management
- **coding**: Standard development, quick fixes, and refactoring
- **chat**: Conversational workflows with context-aware responses

### Plan Matching

When a goal is submitted, the `PlanFactory` matches it against enabled plans:

1. Filter plans by `workflowType` (if specified)
2. Evaluate `inputConditions` against the goal:
   - `keywords`: Check if goal contains any listed keyword
   - `pattern`: Match goal against regex pattern
3. Sort matches by priority (highest first)
4. Select the best matching plan or throw if none found

### Variable Substitution

Step inputs support variable substitution using `${variable}` syntax:

- Plan-level variables: `${maxRetries}`
- Context variables: `${goal}`, `${planId}`, `${executionId}`
- Subject variables: `${tenantId}`, `${userId}`, `${sessionId}`
- Step output references: `${step-1.output}`

### Hot Reloading

The `YamlPlanDefinitionRepository` supports file watching for development:

```typescript
const repo = new YamlPlanDefinitionRepository({
  plansDirectory: "./config/plans",
  watchForChanges: true,  // Enable hot reload
});
```
