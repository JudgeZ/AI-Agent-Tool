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

## Authentication

Enterprise deployments enable OIDC SSO. The orchestrator issues an `oss_session` cookie whose value is a UUIDv4. Clients must
forward this cookie on subsequent requests (or send the same value in an `Authorization: Bearer <session-id>` header). Any
session identifier that is missing, blank, longer than 64 characters, or not a valid UUID is rejected with a `400 Invalid
Request` response and logged as an audit failure. Ensure HTTP clients preserve the exact cookie value without applying
additional encoding.

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
    "id": "plan-550e8400-e29b-41d4-a716-446655440000",
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

Server Sent Events stream mirroring `PlanStepEvent` messages. Clients must supply `Accept: text/event-stream`. When the request is routed through the gateway (`GET /events?plan_id=<id>`), session-authenticated callers must forward their session cookie so the gateway can propagate it upstream to the orchestrator. The gateway merges the incoming `Cookie` header with any cookies already present on the upstream request (for example, values supplied by an HTTP client jar) so session state is preserved end-to-end.

The gateway also forwards identity and trace headers for downstream policy enforcement and observability:

- `X-Agent`
- `X-Request-ID`
- `X-Forwarded-For` (original chain plus the gateway interface address appended as the final hop)
- `X-Real-IP` (original caller value followed by the gateway address)

See [Event Schemas](./events.md#plan-step-events) for payload details.

Example chunk:

```
event: plan.step
data: {"planId":"plan-550e8400-e29b-41d4-a716-446655440000","traceId":"trace-123","step":{"id":"s1","state":"queued"}}

```

The connection remains open until the caller disconnects or the plan is fully processed.

## `POST /plan/:planId/steps/:stepId/approve`

Records a human decision for approval-required steps.

### Request

```http
POST /plan/plan-550e8400-e29b-41d4-a716-446655440000/steps/s2/approve
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
  "model": "gpt-4o",
  "provider": "openai",
  "routing": "high_quality",
  "temperature": 0.8
}
```

| Field | Type | Required | Notes |
| - | - | - | - |
| `messages` | array | ✅ | Ordered conversation history. Each item requires `role` (`user`\|`assistant`\|`system`) and `content` (string). |
| `model` | string | optional | Overrides provider default model/deployment. |
| `provider` | string | optional | Restricts routing to a single enabled provider (e.g. `openai`, `local_ollama`). Values are case-insensitive but must match `[A-Za-z0-9._-]+`. When supplied the router does **not** fall back to other providers; failures are surfaced from the requested provider. Requests fail with `404` when the provider is not in `providers.enabled`. |
| `routing` | string | optional | Fallback order (`balanced`, `high_quality`, `low_cost`). Defaults to the configured `providers.defaultRoute`. |
| `temperature` | number | optional | Creativity knob validated between `0` and `2`. Requests that omit the field default to `0.2`. OpenAI, Azure OpenAI, Mistral, and OpenRouter honour the supplied value; other providers ignore it. |

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

### Error format

All endpoints standardise their error payloads to the following shape:

```json
{
  "code": "invalid_request",
  "message": "Request validation failed",
  "details": [
    { "path": "language", "message": "language is required" }
  ],
  "requestId": "req-42f0",
  "traceId": "3fda6b84c4d8cf0b3c4d7a1f9e8b1234"
}
```

Policy denials, for example, return `403` with `code=policy_violation` and a descriptive message. The `requestId`/`traceId` values mirror the `X-Request-Id` and tracing headers for easier correlation with logs and telemetry.

## OAuth Helpers

The orchestrator exposes thin wrappers to complete OAuth 2.1 + PKCE flows for provider integrations.

- `GET /auth/:provider/authorize` – initiates OAuth by redirecting to the upstream provider. Returns `302` to the provider login page.
- `POST /auth/:provider/callback` – exchanges the authorization code. Body must include `code`, `code_verifier`, and `redirect_uri`. On success the orchestrator persists tokens and returns `{ "status": "ok" }`; errors follow the schema above with provider-specific codes/messages.

## Security Notes

- **mTLS**: When `config.server.tls.requestClientCert` is true, all HTTPS callers must present a certificate signed by a configured CA bundle.
- **Rate limits**: Customize per environment via `config.server.rateLimits.plan|chat` or Helm values. Exceeding limits returns `429 Too Many Requests`.
- **Capability policies**: All mutating endpoints are evaluated against the OPA capability policy. Use the `X-Agent` header or `agent` payload fields to select the policy context.
- **Agent header & rate limiting**: The orchestrator only considers `X-Agent` for rate limiting once a trusted session is established. Unauthenticated calls are bucketed by client IP even if they spoof agent names.

