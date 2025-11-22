# Distributed File Locking Semantics

This orchestrator coordinates file access across agents by combining in-memory bookkeeping with a shared Redis-backed lock service. The goals are to prevent concurrent edits to the same path, preserve recoverability after crashes, and provide auditable, observable operations.

## Scope
- **Lock granularity:** Per-normalized file path (POSIX-style), hashed for collaboration room coordination.
- **Ownership:** Locks are scoped to a sanitized session identifier; each session maintains a history of held paths.
- **TTL:** Locks default to `LOCK_TTL_MS` (30 seconds by default) and are released automatically by Redis when expired.
- **History retention:** Session lock history is persisted in Redis for optional TTL (`LOCK_HISTORY_TTL_SEC`).

## Lifecycle
1. **Acquire**
   - Validate the session identifier and normalize the target path.
   - Enforce per-session rate limits (`LOCK_RATE_LIMIT_PER_MIN` over `LOCK_RATE_LIMIT_WINDOW_MS`).
   - Reject if a collaboration room is already busy.
   - Request a distributed lock from Redis via `DistributedLockService` with retry semantics.
   - Persist the updated lock history to Redis.

2. **Use**
   - File operations run under the held lock. Audit logs include `sessionId`, `agentId`, `requestId`, and `traceId`.
   - Trace context is propagated to lock acquisition to correlate with upstream spans.

3. **Release**
   - On explicit release or session shutdown, all held locks are released and history is refreshed.
   - Local bookkeeping removes cleared sessions and resets rate-limiter state.

## Failure Handling
- **Contention/timeouts:** If Redis cannot grant the lock after retries, callers receive a `busy` error with a `lock_contended` or `lock_timeout` reason.
- **Unavailable Redis:** Connection failures surface as `unavailable` errors with normalized details.
- **Rate limits:** Exceeding session quotas returns `rate_limited` with the enforced window/limit to prevent abusive patterns.
- **Restore:** Sessions automatically attempt to reacquire persisted locks on startup; invalid history is skipped with warnings.

## Configuration
- `LOCK_REDIS_URL` (preferred) / `REDIS_URL`: Redis endpoint for distributed locks.
- `LOCK_TTL_MS`: TTL for individual locks.
- `LOCK_RATE_LIMIT_PER_MIN`, `LOCK_RATE_LIMIT_WINDOW_MS`: Per-session lock acquisition quotas.
- `LOCK_HISTORY_TTL_SEC`: Optional expiry for persisted session lock history.

Keep these settings aligned across services to avoid divergent behavior between lock clients.
