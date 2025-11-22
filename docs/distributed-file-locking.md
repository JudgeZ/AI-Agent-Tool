# Distributed File Locking

This note documents how the orchestrator coordinates file locks across agents and sessions using Redis-backed locks. It captures the intended behavior so operators and contributors understand the guarantees and configuration surface.

## Goals and Scope
- Prevent concurrent writes (and reads during writes) to the same file across agents and rooms.
- Keep lock lifecycle observable with trace context, audit logs, and persisted history.
- Bound resource usage via TTLs and per-session rate limiting to avoid leaked locks or runaway memory.
- Work against a single Redis endpoint per process to enforce consistent lock ownership.

## Lock Model
- **Resource key:** `file:<normalized-path>` where paths are normalized to POSIX and forced to start with `/`.
- **Lock type:** Exclusive; acquisition fails when another session holds the lock or the room is busy.
- **TTL:** Default `LOCK_TTL_MS` (30s) capped at 300s. TTL applies per acquire attempt; there is no automatic renewal—callers must reacquire after expiry.
- **Rate limiting:** `LOCK_RATE_LIMIT_PER_MIN` over `LOCK_RATE_LIMIT_WINDOW_MS` per session. Exceeding the window returns `rate_limited`.
- **History persistence:** Each session's lock paths are stored in Redis under `session:locks:<sessionId>` with optional expiry `LOCK_HISTORY_TTL_SEC`. History is validated on restore and repersisted on release to keep Redis aligned.

## Lifecycle
1. **Acquire**
   - Validate session ID format and enforce per-session rate limit.
   - Reject when the collaboration room is busy before contacting Redis.
   - Acquire distributed lock with bounded retries; failure surfaces as `busy` or `unavailable`.
   - Persist session history and emit audit log + tracing attributes after a successful acquire.
2. **Release**
   - Wrapped release records unlock in memory and persists updated history; failures are logged but do not throw.
   - Releases are idempotent with token-checked deletion in Redis.
3. **Restore on reconnect**
   - Session history is fetched and validated via schema before attempting reacquisition.
   - Invalid history entries are skipped; valid paths are reacquired with the same lifecycle as a new lock.

## Configuration
- `LOCK_REDIS_URL` / `REDIS_URL`: Redis endpoint. The process reuses a single `DistributedLockService` per URL and rejects mid-run URL changes.
- `LOCK_TTL_MS`: Per-lock TTL in milliseconds (capped at 300_000ms).
- `LOCK_HISTORY_TTL_SEC`: Optional expiry for stored session history. Non-positive values disable expiry.
- `LOCK_RATE_LIMIT_PER_MIN`, `LOCK_RATE_LIMIT_WINDOW_MS`: Per-session rate limiting parameters.

## Failure Handling and Observability
- Busy paths raise `FileLockError` with code `busy`; rate limit breaches raise `rate_limited`; Redis or connection errors return `unavailable`.
- Structured logs include `path`, `sessionId`, `agentId` (when provided), and trace context on both acquire and release.
- Redis client errors and history persistence issues log warnings; persistence failures during acquire trigger a best-effort rollback of the lock.

## Operational Notes
- Keep Redis reachable with low latency; acquisition retries default to 3 attempts with 100ms delay. The TTL bounds prevent orphaned locks if clients disconnect.
- Because TTLs are not auto-renewed, long-running edits should renew by reacquiring before TTL expiry if exclusivity must be maintained.
- Room-level busy checks guard against concurrent edits even before hitting Redis, reducing contention.
