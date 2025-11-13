# Code Review: Gateway API (`apps/gateway-api`)

This document summarizes the findings of the comprehensive code review for the Gateway API module.

> **Canonical module path:** `github.com/OSS-AI-Agent-Tool/OSS-AI-Agent-Tool/apps/gateway-api`

## Summary

The Gateway API is a well-structured Go application that serves as a secure proxy for SSE events and handles OAuth 2.1 + PKCE authentication flows. The code demonstrates strong security practices in authentication handling, proper SSE streaming semantics, and mTLS support. However, critical gaps exist in observability (no OTel tracing), input validation, rate limiting, and production-grade security headers.

**Overall Status:** Good (with critical improvements needed for production)

## Findings by Category

### 1. Security Analysis (STRIDE)

#### Spoofing (Identity)
-   **PASS**: OAuth 2.1 + PKCE implementation in `auth.go` (lines 113-138) is correct with state validation, code verifier/challenge generation using SHA-256, and proper cookie-based state management.
-   **PASS**: mTLS support in `orchestrator_client.go` (lines 33-67) correctly validates client certificates with minimum TLS 1.2.
-   **CRITICAL**: Missing `X-Forwarded-For` header validation in SSE proxy (lines 72-78 in `events.go`). Malicious clients could spoof source IPs.
-   **NEEDS IMPROVEMENT**: No rate limiting on authentication endpoints. Vulnerable to credential stuffing and state enumeration attacks.

#### Tampering (Data Integrity)
-   **PASS**: OAuth state cookies (lines 433-452 in `auth.go`) use HttpOnly, Secure (when TLS detected), and SameSite=Lax flags.
-   **CRITICAL**: No integrity checking on proxied SSE payloads. While acceptable for a transparent proxy, consider adding optional HMAC verification for high-security deployments.
-   **NEEDS IMPROVEMENT**: Cookie manipulation protection relies on client-side state. Consider server-side session storage for enterprise mode.

#### Repudiation (Auditability)
-   **CRITICAL**: No audit logging of authentication events (successful/failed logins, OAuth flows).
-   **CRITICAL**: No request ID generation or propagation for tracing authentication flows end-to-end.
-   **NEEDS IMPROVEMENT**: No logging of proxied plan IDs or user identities accessing SSE streams.

#### Information Disclosure (Data Leakage)
-   **PASS**: OAuth redirect URI validation (lines 307-329 in `auth.go`) prevents open redirect attacks by checking against allowlist.
-   **PASS**: Loopback localhost/127.0.0.1 properly allowed for local development (lines 313-318).
-   **CRITICAL**: Error messages leak internal state (line 208 in `auth.go` forwards orchestrator errors verbatim to clients).
-   **NEEDS IMPROVEMENT**: No security headers (X-Content-Type-Options, X-Frame-Options, CSP) to prevent MIME sniffing and clickjacking.

#### Denial of Service
-   **CRITICAL**: No rate limiting on any endpoint. Vulnerable to:
    - SSE stream exhaustion (unlimited concurrent connections per plan_id)
    - OAuth state cookie flooding (lines 119-130 in `auth.go`)
    - OIDC discovery cache stampede (lines 568-620 in `auth.go`)
-   **PASS**: Read timeout (15s), write timeout (60s), and idle timeout (60s) configured in `main.go` (lines 31-33).
-   **NEEDS IMPROVEMENT**: No connection limits or backpressure on SSE streams. Large payloads from orchestrator could exhaust gateway memory.

#### Elevation of Privilege
-   **PASS**: Runs as non-root user (65532) in Dockerfile (line 18).
-   **PASS**: Uses distroless base image reducing attack surface.
-   **NEEDS IMPROVEMENT**: No capability restrictions enforced at runtime (add securityContext in Helm deployment).

### 2. Input Validation & Sanitization

-   **PARTIAL**: `plan_id` query parameter validated for presence (line 57 in `events.go`) but not sanitized before use. Uses `url.PathEscape` (line 62) which is correct, but should validate format (UUID/alphanumeric).
-   **CRITICAL**: `redirect_uri` validation (lines 307-329 in `auth.go`) only checks origin allowlist, not path traversal or protocol smuggling.
-   **NEEDS IMPROVEMENT**: No validation on `state` parameter length or format (line 158 in `auth.go`). Should enforce max length to prevent cookie overflow.
-   **PASS**: Authorization header properly forwarded without modification (lines 73-75 in `events.go`).

### 3. OAuth 2.1 + PKCE Implementation

-   **PASS**: PKCE challenge uses SHA-256 (line 284 in `auth.go`) with base64url encoding per RFC 7636.
-   **PASS**: Code verifier length (64 bytes) and state (32 bytes) meet security requirements (lines 262-273).
-   **PASS**: State cookies expire after 10 minutes (line 23) with proper TTL validation (line 474).
-   **EXCELLENT**: OIDC discovery caching (lines 568-620) prevents repeated requests with 15-minute TTL and double-checked locking pattern.
-   **NEEDS IMPROVEMENT**: No CSRF token separate from state. While PKCE provides some protection, dedicated CSRF tokens recommended for enterprise.
-   **CRITICAL**: Missing scope validation. Orchestrator should validate requested scopes match provider configuration.

### 4. SSE Streaming Implementation

-   **EXCELLENT**: Proper SSE headers set (lines 105-107 in `events.go`): Content-Type, Cache-Control, Connection keep-alive.
-   **EXCELLENT**: Heartbeat mechanism (lines 118-140) with configurable interval (default 30s) prevents connection timeout.
-   **EXCELLENT**: flushingWriter (lines 143-157) ensures immediate event delivery with proper mutex protection.
-   **PASS**: Context cancellation handling (lines 123-126) gracefully closes upstream connection.
-   **NEEDS IMPROVEMENT**: No Last-Event-ID resumption support beyond header forwarding (line 76-78). Gateway could cache recent events for reconnection.
-   **CRITICAL**: No maximum connection duration. Long-lived connections could leak resources if clients never disconnect.
-   **NEEDS IMPROVEMENT**: Error handling (lines 128-131) cannot reliably send error to client mid-stream. Consider structured SSE error events.

### 5. mTLS & TLS Configuration

-   **PASS**: Minimum TLS 1.2 enforced (line 46 in `orchestrator_client.go`).
-   **PASS**: Custom CA certificate support (lines 50-60) for internal PKI.
-   **PASS**: Server name verification configurable (lines 62-64) for SNI requirements.
-   **NEEDS IMPROVEMENT**: No TLS 1.3 preference. Consider `MinVersion: tls.VersionTLS13` for forward secrecy.
-   **NEEDS IMPROVEMENT**: No cipher suite restrictions. Should explicitly allow only strong ciphers (ECDHE+AESGCM).
-   **PASS**: ResponseHeaderTimeout (30s) prevents slow header attacks (line 31 in `orchestrator_client.go`).

### 6. Go Best Practices

-   **EXCELLENT**: Graceful shutdown (lines 36-47 in `main.go`) with 10-second timeout and proper signal handling.
-   **PASS**: Context propagation throughout request lifecycle.
-   **PASS**: Use of sync.Once for client initialization (lines 22-27 in `orchestrator_client.go`) prevents races.
-   **PASS**: Proper error wrapping with %w (lines 42, 53, 57 in `orchestrator_client.go`).
-   **NEEDS IMPROVEMENT**: Global mutable state (`allowedRedirectOrigins`, `oidcDiscoveryCache`) makes testing harder and risks races.
-   **NEEDS IMPROVEMENT**: Panic on startup errors (line 48 in `events.go`) is acceptable but should log error details first.

### 7. Test Coverage

-   **GOOD**: OAuth redirect validation thoroughly tested (45 lines in `auth_test.go`) covering allowlist, loopback, and rejection cases.
-   **GOOD**: mTLS configuration tested (85 lines in `orchestrator_client_test.go`) with certificate loading injection.
-   **GOOD**: SSE forwarding tested (113 lines in `routes_test.go`) with mock orchestrator.
-   **CRITICAL GAPS**:
    - No tests for PKCE generation/validation
    - No tests for state cookie expiration/manipulation
    - No tests for OIDC discovery caching/failure
    - No tests for heartbeat mechanism
    - No tests for concurrent SSE connections
    - No integration tests with real OAuth providers
    - No load tests for connection limits

### 8. Performance Characteristics

-   **GOOD**: Efficient SSE streaming with io.Copy (line 114 in `events.go`) and immediate flushing.
-   **GOOD**: OIDC discovery caching reduces latency by ~100-500ms per auth request.
-   **NEEDS IMPROVEMENT**: No connection pooling metrics or monitoring. Should expose Prometheus metrics for:
    - Active SSE connection count per plan_id
    - OAuth flow duration (p50, p95, p99)
    - Orchestrator upstream latency
    - Error rates by endpoint
-   **CRITICAL**: No memory limits on buffered SSE data. Slow clients could cause backpressure.
-   **NEEDS IMPROVEMENT**: No CPU/memory profiling endpoints (pprof) for production debugging.

### 9. Observability (Critical Gap)

-   **CRITICAL**: No OpenTelemetry tracing. Cannot correlate requests across gateway → orchestrator → agents.
-   **CRITICAL**: Standard library `log` package provides no structured logging. Missing fields:
    - trace_id, span_id
    - plan_id, user_id
    - upstream_latency
    - error_type
-   **CRITICAL**: No metrics exported for Prometheus/Grafana:
    - http_requests_total{method, path, status}
    - sse_connections_active{plan_id}
    - oauth_flow_duration_seconds{provider, status}
-   **NEEDS IMPROVEMENT**: No health check for orchestrator connectivity (only self health at /healthz).

### 10. Configuration & Environment

-   **PASS**: Sensible defaults for all environment variables.
-   **PASS**: Duration parsing with fallback (line 535-543 in `auth.go`).
-   **NEEDS IMPROVEMENT**: No configuration validation at startup. Should fail fast if ORCHESTRATOR_URL invalid.
-   **NEEDS IMPROVEMENT**: No support for configuration file (only env vars). Consider YAML config for complex deployments.

## Recommendations (Prioritized)

### Critical (P0) - Security & Reliability

1.  **Add OpenTelemetry Tracing**: Instrument all handlers with OTel HTTP middleware. Propagate trace context to orchestrator via `traceparent` header. Track spans for OAuth flows, SSE streaming, and mTLS handshakes.

2.  **Implement Rate Limiting**: Add per-IP rate limits using `golang.org/x/time/rate`:
    - Auth endpoints: 10 req/min per IP
    - SSE streams: 5 concurrent connections per plan_id
    - OIDC discovery: 1 req/sec (shared across all requests)

3.  **Add Request ID Middleware**: Generate unique request IDs (UUIDs) and include in all logs and error responses. Add X-Request-ID header to upstream requests.

4.  **Sanitize Error Messages**: Replace line 208 in `auth.go` with generic error for clients, log detailed error server-side with request ID.

5.  **Add Security Headers Middleware**:
```go
w.Header().Set("X-Content-Type-Options", "nosniff")
w.Header().Set("X-Frame-Options", "DENY")
w.Header().Set("Content-Security-Policy", "default-src 'none'")
w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
```

6.  **Validate Input Formats**: Add regex validation for plan_id (UUID format), state (alphanumeric), and redirect_uri path components.

### High (P1) - Production Readiness

7.  **Structured Logging**: Replace `log` package with `slog` (Go 1.21+):
```go
slog.Info("sse stream started",
    "plan_id", planID,
    "remote_addr", r.RemoteAddr,
    "request_id", reqID,
)
```

8.  **Prometheus Metrics**: Export metrics using `github.com/prometheus/client_golang`:
    - http_request_duration_seconds{handler, method, status}
    - gateway_sse_connections{plan_id}
    - gateway_oauth_flows_total{provider, status}
    - gateway_upstream_errors_total

9.  **Connection Limits**: Add max connection duration (1 hour) and max concurrent connections per client IP (10).

10. **Add Audit Logging**: Log all authentication events (success/failure), OAuth provider, user identity, IP address, timestamp to separate audit log file/stream.

11. **Expand Test Coverage**: Add tests for PKCE validation, state expiration, OIDC caching, concurrent SSE connections, and error scenarios. Target 80% coverage minimum.

### Medium (P2) - Enhancement

12. **SSE Event Caching**: Implement ring buffer (last 100 events per plan_id) for Last-Event-ID resumption support.

13. **TLS 1.3 Preference**: Update `orchestrator_client.go` to prefer TLS 1.3, restrict cipher suites to ECDHE+AESGCM only.

14. **Configuration Validation**: Add startup validation function that checks ORCHESTRATOR_URL reachability, TLS certificate validity, and OAuth provider endpoints.

15. **Graceful Degradation**: Add circuit breaker for orchestrator requests using `github.com/sony/gobreaker`. Return 503 with Retry-After header when orchestrator unavailable.

16. **Memory Profiling**: Add `net/http/pprof` endpoints behind admin token for production debugging.

### Low (P3) - Nice to Have

17. **YAML Configuration Support**: Allow loading config from file in addition to environment variables.

18. **Separate CSRF Tokens**: Add dedicated CSRF token field in auth flow for defense-in-depth.

19. **Scope Validation**: Pre-validate OAuth scopes against provider requirements before redirecting.

20. **Health Check Enhancement**: Add `/readyz` endpoint that checks orchestrator connectivity via HEAD request with 2-second timeout.

## Compliance with Architectural Doctrine

| Requirement | Status | Notes |
|-------------|--------|-------|
| SSE for streaming | ✅ PASS | Correct headers, heartbeat, flushing |
| OAuth 2.1 + PKCE | ✅ PASS | Proper implementation with state validation |
| mTLS support | ✅ PASS | Configurable client certs and custom CA |
| OTel tracing | ❌ FAIL | No tracing implementation |
| Structured logging | ❌ FAIL | Uses standard log package |
| Graceful shutdown | ✅ PASS | Signal handling with timeout |
| Security by default | ⚠️  PARTIAL | Good TLS/auth, missing rate limits and headers |
| Non-root execution | ✅ PASS | Runs as user 65532 in container |
| Least privilege | ⚠️  PARTIAL | Container config good, missing runtime caps |
| Input validation | ⚠️  PARTIAL | Some validation, needs format checks |

## Test Execution

To run Gateway API tests:
```bash
cd apps/gateway-api
go test -v -race -coverprofile=coverage.out ./...
go tool cover -html=coverage.out -o coverage.html
```

Current coverage: ~65% (estimated). Target: 80%+
