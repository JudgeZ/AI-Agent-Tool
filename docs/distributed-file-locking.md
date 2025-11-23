# Distributed file locking

This orchestrator uses Redis-backed distributed locks to serialize read/write access to project files and protect collaborative editing sessions. Locks are mandatory for both read and write operations to avoid torn reads and ensure agents observe consistent state during tool execution.

## Lock scope and lifecycle
- **Resource key**: Each normalized absolute file path is mapped to a `file:<path>` lock key derived from a SHA-256 room identifier.
- **TTL enforcement**: Lock TTL is configurable via `LOCK_TTL_MS` (default: 30s, capped at 5 minutes) and is applied to every acquisition. TTL requests above the cap are trimmed to the maximum to protect against runaway locks.
- **Acquisition**: Requests use a best-effort retry policy (`DistributedLockService`) and are rate-limited per session (see below). Session IDs must be alphanumeric/`-_` and ≤128 characters; invalid identifiers are rejected.
- **Persistence**: Per-session lock history is stored in Redis using `LOCK_HISTORY_TTL_SEC` when set, enabling reattachment after orchestrator restarts. History is cleared on release.
- **Restore**: On reconnect, the manager reads stored paths and re-acquires locks with per-lock timeouts and small backoffs to avoid blocking other restores.
- **Release**: Releases remove in-memory tracking, persist updated history, and log the event. Failures to release are surfaced and logged without leaking secrets.

## Rate limiting and multi-instance deployments
- **Per-session rate limit**: Controlled by `LOCK_RATE_LIMIT_PER_MIN` and `LOCK_RATE_LIMIT_WINDOW_MS`; enforced before every acquire/restore attempt with structured errors on exhaustion.
- **Backend selection**: By default, limits use the in-memory store. To share quotas across orchestrator instances, configure a Redis backend via `ORCHESTRATOR_RATE_LIMIT_BACKEND=redis` and `ORCHESTRATOR_RATE_LIMIT_REDIS_URL` (or `RATE_LIMIT_REDIS_URL`). Without Redis, limits are per-process and scale with the number of replicas.
- **Cleanup**: Calling `releaseSessionLocks` clears both active locks and rate-limit counters for that session.

## Metrics and observability
- **Lock attempts**: `orchestrator_file_lock_attempts_total{operation,outcome}` and latency histogram `orchestrator_file_lock_attempt_seconds{operation,outcome}` capture success/error/busy/rate-limited paths.
- **Successful acquisitions**: `orchestrator_file_lock_acquire_seconds{operation}` records latency for completed acquisitions.
- **Contention**: `orchestrator_file_lock_contention_total{operation,reason}` distinguishes `room_busy`, `lock_contended`, and `lock_timeout` scenarios.
- **Rate limiting**: `orchestrator_file_lock_rate_limit_total{operation,result}` reports allowed vs. blocked checks.
- **Releases**: `orchestrator_file_lock_release_total{outcome}` counts release results.

## Operational constraints and expectations
- Redis availability is required for lock coordination and history persistence; connection failures surface as `unavailable` errors and are logged with normalized error details.
- Locks apply to reads to prevent agents from reading inconsistent data while writes are in flight; removing read locks would risk correctness.
- Keep TTLs modest to reduce the chance of stale locks; rely on restore/backoff logic rather than long TTLs for resiliency.
- Ensure tracing (`trace_id`, `span_id`) and request IDs propagate to lock operations for cross-service debugging.
