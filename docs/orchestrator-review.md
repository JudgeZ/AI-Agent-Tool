# Code Review: Orchestrator (`services/orchestrator`)

This document summarizes the findings of the comprehensive code review for the Orchestrator module.

## Summary

The Orchestrator is the core service of the OSS AI Agent Tool, orchestrating planning, execution, authentication, and multi-provider routing. The TypeScript codebase demonstrates strong architectural patterns including OPA-based policy enforcement, dual-loop execution (gRPC + queues), comprehensive OAuth/OIDC authentication, and pluggable secrets management (Vault/local). However, critical gaps exist in input validation (incomplete zod usage), dependency injection patterns, error handling standardization, and security hardening (CORS, session fixation, token rotation).

**Overall Status:** Good (production-ready with high-priority improvements needed)

## Findings by Category

### 1. Security Analysis (STRIDE)

#### Spoofing (Identity)
-   **EXCELLENT**: OPA-based policy enforcement (lines 216-230 in `index.ts`) with capability checking before every privileged operation.
-   **PASS**: OIDC integration (lines 201-204) with proper session management and tenant isolation support.
-   **PASS**: OAuth 2.0 provider authentication with Vault/LocalKeystore backend (lines 1-71 in `SecretsStore.ts`).
-   **CRITICAL**: Session fixation vulnerability - no session ID regeneration after authentication (missing in `OidcController.ts`).
-   **CRITICAL**: No X-Forwarded-For or client IP tracking in audit logs. Spoofed IPs could bypass rate limiting if behind proxy.
-   **NEEDS IMPROVEMENT**: Token rotation not implemented for Vault tokens (lines 287-290 in `SecretsStore.ts` track expiry but don't proactively renew).

#### Tampering (Data Integrity)
-   **EXCELLENT**: Zod validation for all plan-related schemas (`validation.ts` lines 1-136) ensures data integrity.
-   **PASS**: HTTPS/TLS support with client cert verification (lines 389-407 in `index.ts`).
-   **CRITICAL**: Message integrity not verified in queue messages. Malicious queue producers could inject arbitrary plan steps.
-   **NEEDS IMPROVEMENT**: No HMAC or signature verification on OAuth callbacks (vulnerable to callback interception in `OAuthController.ts`).
-   **NEEDS IMPROVEMENT**: Policy WASM loaded from filesystem without integrity check (lines 174-192 in `PolicyEnforcer.ts`).

#### Repudiation (Auditability)
-   **PASS**: OpenTelemetry tracing with trace ID propagation (lines 19, 218-243 in `index.ts`).
-   **CRITICAL**: No audit logging for policy violations, authentication failures, or privilege escalation attempts.
-   **CRITICAL**: Approval decisions logged but no cryptographic proof (lines 295-330 in `index.ts`). Consider signing approval records.
-   **NEEDS IMPROVEMENT**: No logging of user identity in plan execution (subject context passed but not logged in `PlanQueueRuntime.ts`).

#### Information Disclosure (Data Leakage)
-   **PASS**: Secrets abstraction prevents accidental logging (lines 8-12 in `SecretsStore.ts`).
-   **CRITICAL**: Error messages leak internal state (line 383 in `index.ts` returns error.message to client without sanitization).
-   **CRITICAL**: Stack traces potentially exposed in dev mode via morgan logger (line 171).
-   **NEEDS IMPROVEMENT**: No redaction of sensitive fields (tokens, API keys) in tracing spans.
-   **NEEDS IMPROVEMENT**: Config file (lines 1-150 in `config.ts`) could expose sensitive env var names in error messages.
-   **IMPROVEMENT**: Session store now retains only identity metadata; raw OIDC tokens are discarded after issuance to reduce in-memory secrets exposure.

#### Denial of Service
-   **PASS**: Rate limiting on /plan and /chat endpoints (lines 173-184 in `index.ts`).
-   **PASS**: Request body size limit (1MB) (line 170).
-   **CRITICAL**: No timeout on policy evaluation (lines 280-291 in `PolicyEnforcer.ts`). Malicious policies could hang indefinitely.
-   **CRITICAL**: No max queue depth enforcement. Unbounded enqueue could exhaust memory/disk (lines 129-131 in `RabbitMQAdapter.ts`).
-   **CRITICAL**: SSE connections unbounded (line 250-293 in `index.ts`). No max concurrent connections per plan_id or per client.
-   **NEEDS IMPROVEMENT**: Vault auto-retry on 401/403 (lines 379-382 in `SecretsStore.ts`) has no max retry count.

#### Elevation of Privilege
-   **EXCELLENT**: Capability-based authorization with OPA prevents unauthorized actions (lines 236-240, 314-330, 339-353 in `index.ts`).
-   **PASS**: Agent profiles define capabilities explicitly (lines 346-371 in `PolicyEnforcer.ts`).
-   **NEEDS IMPROVEMENT**: Fallback agent profile (lines 353-367 in `PolicyEnforcer.ts`) grants requested capabilities on load failure. Should deny instead.
-   **NEEDS IMPROVEMENT**: No capability escalation audit. Should log when capabilities change or approvals bypass normal flow.

### 2. Input Validation & Schema Coverage

-   **EXCELLENT**: Comprehensive zod schemas for plans, steps, events, jobs (all of `validation.ts`).
-   **PARTIAL**: HTTP request body validation inconsistent:
    - `/plan`: goal validated for presence (line 210-214) but not format/length
    - `/chat`: messages array presence checked (line 334-337) but not content structure
    - `/approve`: decision/rationale manually validated (line 308-310) instead of zod
-   **CRITICAL**: No validation on X-Agent header format (line 42-47 in `index.ts`). Could inject malicious agent names.
-   **NEEDS IMPROVEMENT**: Query parameters not validated (e.g., plan_id format in `/plan/:id/events`).
-   **NEEDS IMPROVEMENT**: Environment variable validation in `config.ts` could be strengthened with zod schemas.

### 3. OAuth/OIDC Implementation

-   **PASS**: OAuth controller implements standard authorize/callback flow (lines 206-207 in `index.ts`).
-   **PASS**: OIDC session management with TTL and cookie-based storage (lines 201-204).
-   **NEEDS IMPROVEMENT**: Session store cleanup only on read (line 110 in `index.ts`). Should have background cleanup task.
-   **NEEDS IMPROVEMENT**: No refresh token support. Long-lived sessions require re-authentication.
-   **CRITICAL**: Session cookies not explicitly set with Secure/HttpOnly/SameSite attributes (missing in `OidcController.ts`).
-   **NEEDS IMPROVEMENT**: Role mappings from OIDC claims (lines 84-89 in `config.ts`) but no validation of claim types.

### 4. Secrets Management

-   **EXCELLENT**: Pluggable secrets backend (Vault vs LocalFileStore) (lines 63-69 in `ProviderRegistry.ts`).
-   **EXCELLENT**: Vault Kubernetes auth support with JWT rotation (lines 320-366 in `SecretsStore.ts`).
-   **PASS**: LocalFileStore encryption with passphrase (lines 19-71 in `SecretsStore.ts`).
-   **CRITICAL**: LocalFileStore passphrase required but error message exposes storage path (line 54 in `SecretsStore.ts`).
-   **NEEDS IMPROVEMENT**: No secret rotation mechanism. Secrets stored indefinitely until manual deletion.
-   **NEEDS IMPROVEMENT**: Vault token renewal uses deadline calculation (lines 171-181) but no background renewal task.
-   **NEEDS IMPROVEMENT**: VaultStore doesn't verify TLS cert expiry (lines 210-224 in `SecretsStore.ts`).

### 5. Policy Enforcement (OPA)

-   **EXCELLENT**: OPA WASM integration for portable, auditable policy enforcement (lines 174-192 in `PolicyEnforcer.ts`).
-   **EXCELLENT**: Runtime policy data merging supports dynamic role bindings (lines 94-148 in `PolicyEnforcer.ts`).
-   **PASS**: Policy decisions include deny reasons for debugging (lines 194-212).
-   **NEEDS IMPROVEMENT**: Policy cache never invalidates. WASM loaded once at startup; changes require restart.
-   **CRITICAL**: No policy evaluation timeout. Complex policies could cause request delays/timeouts.
-   **NEEDS IMPROVEMENT**: Agent profile caching never expires (line 150 in `PolicyEnforcer.ts`). Profile changes not reflected.
-   **NEEDS IMPROVEMENT**: Fallback profile on load error (lines 353-367) too permissive. Should fail closed.

### 6. Queue Adapters (RabbitMQ & Kafka)

-   **EXCELLENT**: Clean abstraction (lines 32-38 in `QueueAdapter.ts`) enables hot-swapping message brokers.
-   **PASS**: RabbitMQ reconnection with exponential backoff (lines 149-232 in `RabbitMQAdapter.ts`).
-   **PASS**: Idempotency key support (lines 7-10 in `QueueAdapter.ts`) prevents duplicate processing.
-   **PASS**: Dead letter queue support (lines 18-20, 28-30 in `QueueAdapter.ts`).
-   **CRITICAL**: No message authentication. Malicious producers could inject messages to queues.
-   **CRITICAL**: Inflight deduplication (line 67 in `RabbitMQAdapter.ts`) uses Set<string> - unbounded memory growth.
-   **NEEDS IMPROVEMENT**: No message size limits. Large messages could exhaust memory.
-   **NEEDS IMPROVEMENT**: Retry delay hardcoded (line 23 in `RabbitMQAdapter.ts`). Should use exponential backoff.
-   **NEEDS IMPROVEMENT**: Queue depth metrics (lines 138-147) but no alerting on high lag.

### 7. Provider Integrations

-   **EXCELLENT**: Multi-provider support (OpenAI, Anthropic, Google, Azure, Bedrock, Mistral, OpenRouter, Ollama) (lines 71-86 in `ProviderRegistry.ts`).
-   **PASS**: Circuit breaker pattern (lines 50-61 in `ProviderRegistry.ts`) protects against failing providers.
-   **PASS**: Rate limiter (lines 37-44) prevents quota exhaustion.
-   **NEEDS IMPROVEMENT**: Provider selection logic not shown in excerpt. Verify least-cost routing doesn't compromise security/privacy.
-   **NEEDS IMPROVEMENT**: No provider-specific timeout configuration. Some models (bedrock) slower than others.
-   **NEEDS IMPROVEMENT**: API key retrieval from secrets store but no caching. Every request fetches from Vault/disk.
-   **CRITICAL**: Provider errors not sanitized before returning to client (lines 370-372 in `index.ts`).

### 8. TypeScript & Code Quality

-   **PASS**: Strict mode enabled (`tsconfig.json`).
-   **PASS**: Comprehensive error handling with try-catch in all route handlers (lines 216-248, 295-330, 332-373 in `index.ts`).
-   **NEEDS IMPROVEMENT**: Dependency injection via singletons (lines 70-82 in `QueueAdapter.ts`, 216 in `PolicyEnforcer.ts`). Makes testing difficult.
-   **NEEDS IMPROVEMENT**: Global state (cachedRegistry, rateLimiter, circuitBreaker in `ProviderRegistry.ts` lines 16-21) risks race conditions.
-   **NEEDS IMPROVEMENT**: Async initialization (lines 417-427 in `index.ts`) but no health check to verify readiness.
-   **PASS**: Error classes with structured details (lines 22-32 in `PolicyEnforcer.ts`).

### 9. Test Coverage & Quality

-   **GOOD**: Extensive test files across all modules (list shown in `list_dir` output).
-   **GOOD**: Integration tests for queue runtime (PlanQueueRuntime.kafka.test.ts, PlanQueueRuntime.rabbitmq.test.ts).
-   **NEEDS IMPROVEMENT**: Coverage metrics not visible. Estimate 60-70% coverage.
-   **CRITICAL GAPS**:
    - No security tests (policy bypass attempts, privilege escalation)
    - No OAuth/OIDC integration tests with real providers
    - No Vault authentication failure scenarios
    - No queue message tampering tests
    - No SSE connection limit tests
    - No concurrency tests (race conditions in caching)

### 10. Observability

-   **EXCELLENT**: OpenTelemetry tracing with span creation for all operations (lines 218-243 in `index.ts`).
-   **PASS**: Prometheus metrics exposed at /metrics (lines 190-199).
-   **PASS**: Queue metrics (ack, retry, dead letter, depth, lag) (lines 6-10 in `RabbitMQAdapter.ts`).
-   **NEEDS IMPROVEMENT**: No correlation ID separate from trace ID for client requests.
-   **NEEDS IMPROVEMENT**: Metrics lack high-cardinality labels (plan_id, user_id). Can't track per-tenant usage.
-   **NEEDS IMPROVEMENT**: Morgan dev logger (line 171) not production-ready. Should use structured JSON logging.
-   **CRITICAL**: No alert definitions. Metrics exported but no monitoring/alerting configured.

### 11. Configuration Management

-   **PASS**: Environment variable driven with sensible defaults (shown throughout `config.ts`).
-   **PASS**: YAML config support for complex nested structures (lines 1-4 in `config.ts`).
-   **NEEDS IMPROVEMENT**: Config validation at load time (lines 137-145) but errors unhelpful (context string only).
-   **NEEDS IMPROVEMENT**: No config hot-reload. All changes require restart.
-   **NEEDS IMPROVEMENT**: 1600+ line config file difficult to maintain. Should split into modules.

### 12. Performance Characteristics

-   **GOOD**: Rate limiting protects backend services (lines 173-184 in `index.ts`).
-   **GOOD**: Circuit breakers prevent cascading failures (lines 50-61 in `ProviderRegistry.ts`).
-   **NEEDS IMPROVEMENT**: No response time tracking. Can't identify slow requests.
-   **NEEDS IMPROVEMENT**: SSE keep-alive interval (line 279 in `index.ts`) configurable but default unknown.
-   **NEEDS IMPROVEMENT**: Queue prefetch (line 24 in `RabbitMQAdapter.ts`) hardcoded. Should be tunable based on worker count.
-   **CRITICAL**: No request queueing/backpressure. Burst traffic could overwhelm queue/policy evaluator.
-   **NEEDS IMPROVEMENT**: Policy evaluation synchronous (lines 280-291 in `PolicyEnforcer.ts`). Could batch for efficiency.

## Recommendations (Prioritized)

### Critical (P0) - Security & Correctness

1.  **Implement Session Fixation Protection**: Regenerate session ID after authentication in `OidcController.ts`. Use crypto.randomUUID() for new session ID.

2.  **Add Input Validation**: Create zod schemas for all HTTP endpoints:
```typescript
const CreatePlanSchema = z.object({
  goal: z.string().min(1).max(10000)
});
const ApprovePlanSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  rationale: z.string().max(5000).optional()
});
```

3.  **Sanitize Error Messages**: Replace line 383 in `index.ts` with:
```typescript
res.status(500).json({ error: "Internal server error", requestId: req.headers["x-request-id"] });
```
Log full error server-side with trace ID.

4.  **Add Policy Evaluation Timeout**: Wrap policy.evaluate() with timeout (5s) to prevent DoS.

5.  **Fix Fallback Agent Profile**: Change lines 353-367 in `PolicyEnforcer.ts` to return empty capabilities or throw error instead of granting requested capabilities.

6.  **Implement Message Authentication**: Add HMAC signature to queue messages. Verify on consume. Use shared secret from Vault.

7.  **Add Session Cookie Security**: Set Secure, HttpOnly, SameSite=Strict on all session cookies in `OidcController.ts`.

8.  **Bounded Inflight Deduplication**: Replace Set<string> (line 67 in `RabbitMQAdapter.ts`) with LRU cache (max 10k entries).

### High (P1) - Reliability & Production Readiness

9.  **Add Audit Logging**: Log all security events to separate audit stream:
    - Authentication success/failure
    - Policy violations
    - Approval decisions
    - Capability escalation

10. **Implement Dependency Injection**: Use `tsyringe` or `inversify`:
```typescript
@injectable()
class PolicyEnforcer {
  constructor(@inject("Config") config: AppConfig) {}
}
```

11. **Add Request Validation Middleware**: Create Express middleware to validate all requests with zod before handlers.

12. **Implement Secret Rotation**: Add background task to rotate provider API keys every 30 days. Store rotation schedule in Vault metadata.

13. **Add Health Checks**: Implement `/readyz` endpoint that checks:
    - Queue connectivity
    - Vault connectivity
    - Policy WASM loaded
    - OTel exporter connected

14. **Expand Test Coverage**: Add tests for:
    - Session fixation attacks
    - Policy bypass attempts
    - Queue message tampering
    - Concurrent plan execution
    - Provider failover scenarios
    Target: 80% coverage minimum.

15. **Add SSE Connection Limits**: Max 100 concurrent SSE connections per client IP. Max 10 per plan_id.

### Medium (P2) - Enhancements

16. **Structured Logging**: Replace morgan with winston or pino for JSON structured logs with trace correlation.

17. **Policy Cache Invalidation**: Add file watcher on policy WASM. Reload on change. Or add /admin/reload-policy endpoint.

18. **Agent Profile Cache Expiry**: Set TTL (5 minutes) on cached profiles. Reload from disk on cache miss.

19. **Provider API Key Caching**: Cache provider keys for 5 minutes to reduce Vault load.

20. **Prometheus Alerts**: Define alerts for:
    - Queue lag > 1000 messages
    - Policy evaluation time > 1s (p95)
    - Error rate > 5%
    - Circuit breaker open

21. **Config Validation Enhancement**: Use zod to validate entire config schema at load time with detailed error messages.

22. **Request Timeout Middleware**: Add global timeout (30s) for all requests.

### Low (P3) - Code Quality

23. **Split Config File**: Extract into modules (auth.ts, messaging.ts, providers.ts, observability.ts).

24. **Add Request ID Middleware**: Generate/extract X-Request-ID for correlation across services.

25. **Provider Timeout Configuration**: Add per-provider timeout settings to config.

26. **Queue Message Size Limits**: Enforce max 1MB message size. Reject larger messages.

27. **Background Session Cleanup**: Run session cleanup every 5 minutes instead of on-demand.

28. **Exponential Retry Backoff**: Update RabbitMQAdapter retry logic to use exponential backoff (1s, 2s, 4s, 8s...).

## Compliance with Architectural Doctrine

| Requirement | Status | Notes |
|-------------|--------|-------|
| Dual-loop architecture | ✅ PASS | gRPC inner loop + queue outer loop implemented |
| OPA policy enforcement | ✅ PASS | WASM-based with capability checking |
| OAuth 2.1 + PKCE | ✅ PASS | Controller implements standard flow |
| OIDC enterprise auth | ✅ PASS | Session management with tenant support |
| OTel tracing | ✅ PASS | Spans for all operations |
| Structured logging | ⚠️  PARTIAL | Morgan dev logger, needs production logger |
| Secrets management | ✅ PASS | Vault + LocalFileStore abstraction |
| Consumer vs Enterprise | ✅ PASS | Run mode configuration with different behaviors |
| Queue abstraction | ✅ PASS | RabbitMQ + Kafka pluggable adapters |
| Multi-provider routing | ✅ PASS | 8 providers with circuit breaker + rate limit |
| Input validation | ⚠️  PARTIAL | Zod for plans but not all HTTP inputs |
| Audit logging | ❌ FAIL | No audit trail implementation |
| Security by default | ⚠️  PARTIAL | Good policy enforcement, weak error handling |

## Test Execution

To run Orchestrator tests:
```bash
cd services/orchestrator
npm test
npm run test:coverage
npm run test:integration
```

Current coverage: ~65% (estimated). Target: 80%+

Integration test requirements:
- Docker for RabbitMQ/Kafka
- Vault dev server (for secrets tests)
- Mock OAuth provider (for OIDC tests)
