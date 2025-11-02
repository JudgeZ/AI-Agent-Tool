# HTTP API Reference

This reference covers the HTTP surfaces exposed by the orchestrator service. All endpoints live under the orchestrator base URL (default `http://localhost:4000`). When mTLS is enabled you **must** connect via HTTPS and present the configured client certificate.

- **Health**: `GET /healthz`
- **Plans**:
  - `POST /plan`
  - `GET /plan/:planId/events`
  - `POST /plan/:planId/steps/:stepId/approve`
- **Chat proxy**: `POST /chat`
- **OAuth helpers**: `GET /auth/:provider/authorize`, `POST /auth/:provider/callback`

Rate limiting is enforced per endpoint using the defaults from `config.server.rateLimits.*` (plan: 60 req/min, chat: 120 req/min unless overridden). All responses include an `X-Trace-Id` header when tracing is enabled.

## Common Errors

| Status | Meaning | Notes |
| - | - | - |
| `400` | Bad request | Validation failed (missing fields, invalid enum values, etc.). |
| `401` | Unauthorized | Capability policy denied the action. |
| `403` | Forbidden | Capability policy blocked the action or TLS client certificate was missing. |
| `409` | Conflict | Step approvals attempted while not in `waiting_approval`. |
| `422` | Unprocessable entity | Payload was well formed but rejected (e.g. OAuth exchange failed). |
| `429` | Too many requests | Rate limit exceeded. |
| `5xx` | Server error | Unhandled exception; inspect orchestrator logs and tracing spans. |

## `GET /healthz`

Simple readiness probe. Always returns:

```json
{ "status": "ok" }
```

## `POST /plan`

Submits a new plan for execution.

### Request

```http
POST /plan
Content-Type: application/json
X-Agent: code-writer

{ "goal": "Ship the next milestone" }
```

Headers:

- `Content-Type: application/json` (required)
- `X-Agent` (optional): Agent profile to evaluate capabilities for.

Body fields:

| Field | Type | Required | Notes |
| - | - | - | - |
| `goal` | string | ✅ | Human-readable objective. |

### Response `201 Created`

```json
{
  "plan": {
    "id": "plan-92a390d6",
    "goal": "Ship the next milestone",
    "steps": [
      {
        "id": "s1",
        "action": "index_repo",
        "capability": "repo.read",
        "capabilityLabel": "Read repository",
        "labels": ["repo", "automation"],
        "tool": "repo_indexer",
        "timeoutSeconds": 120,
        "approvalRequired": false,
        "input": {},
        "metadata": {}
      }
    ],
    "successCriteria": ["All steps complete"]
  },
  "traceId": "3fda6b84c4d8cf0b"
}
```

## `GET /plan/:planId/events`

Server Sent Events stream mirroring `PlanStepEvent` messages. Clients must supply `Accept: text/event-stream`. See [Event Schemas](./events.md#plan-step-events) for payload details.

Example chunk:

```
event: plan.step
data: {"planId":"plan-92a390d6","traceId":"trace-123","step":{"id":"s1","state":"queued"}}

```

The connection remains open until the caller disconnects or the plan is fully processed.

## `POST /plan/:planId/steps/:stepId/approve`

Records a human decision for approval-required steps.

### Request

```http
POST /plan/plan-92a390d6/steps/s2/approve
Content-Type: application/json

{ "decision": "approve", "rationale": "Validated by reviewer" }
```

| Field | Type | Required | Values |
| - | - | - | - |
| `decision` | string | ✅ | `approve` \| `reject` |
| `rationale` | string | optional | Included in step summary and audit trail. |

Returns `204 No Content` on success. A `409` is returned if the step is not currently in `waiting_approval`.

## `POST /chat`

Proxy endpoint for registered providers.

### Request

```http
POST /chat
Content-Type: application/json

{
  "messages": [
    { "role": "user", "content": "Hello" }
  ],
  "model": "gpt-4o"
}
```

| Field | Type | Required | Notes |
| - | - | - | - |
| `messages` | array | ✅ | Ordered conversation history. Each item requires `role` (`user`\|`assistant`\|`system`) and `content` (string). |
| `model` | string | optional | Overrides provider default. |
| `agent` | string | optional | Alternatively supply the agent name in the body. |

### Response `200 OK`

```json
{
  "response": {
    "output": "Hello there!",
    "usage": { "promptTokens": 12, "completionTokens": 4 }
  },
  "traceId": "3fda6b84c4d8cf0b"
}
```

Policy denials return `403` with `{ "error": "plan.create denied by capability policy" }`.

## OAuth Helpers

The orchestrator exposes thin wrappers to complete OAuth 2.1 + PKCE flows for provider integrations.

- `GET /auth/:provider/authorize` – initiates OAuth by redirecting to the upstream provider. Returns `302` to the provider login page.
- `POST /auth/:provider/callback` – exchanges the authorization code. Body must include `code`, `code_verifier`, and `redirect_uri`. On success the orchestrator persists tokens and returns `{ "status": "ok" }`; errors surface as JSON `4xx/5xx` responses.

## Security Notes

- **mTLS**: When `config.server.tls.requestClientCert` is true, all HTTPS callers must present a certificate signed by a configured CA bundle.
- **Rate limits**: Customize per environment via `config.server.rateLimits.plan|chat` or Helm values. Exceeding limits returns `429 Too Many Requests`.
- **Capability policies**: All mutating endpoints are evaluated against the OPA capability policy. Use the `X-Agent` header or `agent` payload fields to select the policy context.

