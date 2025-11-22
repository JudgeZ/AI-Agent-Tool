# TODO Tasks

**How to maintain this file**
- Keep task IDs sequential starting from `T1`; renumber the table when adding or removing tasks to avoid gaps.
- When a task is completed and merged, remove its row entirely; keep only outstanding work here.
- Preserve the column structure and concise descriptions so tasks remain actionable with locations and testing expectations.
- When adding a task, include enough detail in `notes` to implement later and set `test_impact` based on expected changes.

| id | status | description | source | location | test_impact | notes |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | todo | Add rate limiting/per-session limits for lock acquisition and file operations | Reviewer: "Rate Limiting Not Considered" | FileLockManager & FileSystemTool | requires new tests | Design per-session quotas to cap lock attempts/file actions; add enforcement hooks and tests. |
| T2 | todo | Add audit logging for file operations and approvals | Reviewer: "Audit Logging Incomplete" | FileSystemTool execute | requires new tests | Emit structured logs with session/trace/action details for sensitive operations. |
| T3 | todo | Document rename coalescing race window in watcher | Reviewer suggestion | FileWatcherService rename handling | manual only (justify) | Explain behavior when rename/replace events are >500ms apart and potential missed coalescing. |
| T4 | todo | Handle DistributedLockService URL consistency and awaited disconnect when switching endpoints | Reviewer: singleton issues & race | DistributedLockService getDistributedLockService | requires new tests | Ensure URL changes update singleton safely and disconnect awaits before reuse. |
| T5 | todo | Add tests for invalid JSON history, concurrent lock acquisition, timeout handling | Reviewer: "Missing Error Path Tests" | FileLockManager tests | requires new tests | Cover schema validation failures, simultaneous acquisitions, and timeout paths. |
| T6 | todo | Ensure lockHistory map entries are cleaned up/TTL to avoid memory growth | Reviewer: "Potential Memory Leak" | FileLockManager tracking | requires new tests | Add cleanup/TTL for empty session entries and verify eviction logic. |
| T7 | todo | Propagate trace IDs / spans for lock and file operations | Reviewer: "Missing Tracing" | FileLockManager, FileSystemTool | manual only (justify) | Thread trace/span context through lock acquisition and file actions for observability. |
| T8 | todo | Replace unsafe `as` assertion in FileWatcherService entries iteration | Reviewer: TS best practices | FileWatcherService rename handling | update existing tests | Use typed iteration or type guard instead of casting when processing watcher entries. |
| T9 | todo | Add ADR/README for distributed file locking semantics | Reviewer: Documentation | Repo docs | manual only (justify) | Document lock scope, TTL/renewal expectations, and distributed behaviors. |
| T10 | todo | Avoid dual Redis clients; reuse DistributedLockService client or document separation | Reviewer: Blocking issue | FileLockManager constructor | requires new tests | Consolidate Redis client usage or justify separation with configuration/tests. |
| T11 | todo | Make lock acquisition/history persistence atomic or release on persist failure | Reviewer: "lock leak if persist fails" | FileLockManager acquireLock | requires new tests | Ensure failure to persist history rolls back or releases lock to avoid leak. |
| T12 | todo | Make 30s lock TTL configurable/extendable | Reviewer: "TTL may be too short" | FileLockManager acquireLock | requires new tests | Introduce configuration or renewal mechanism for lock TTL with validation. |
| T13 | todo | Prevent first completed plan from releasing shared session locks needed by others | Comment: shared session locks | PlanQueueManager completion | requires new tests | Add reference counting/ownership tracking so shared locks persist until all consumers done. |
| T14 | todo | Ensure configured Redis URL is honored when creating lock singleton | Comment: "Redis lock URL ignored" | DistributedLockService getDistributedLockService | requires new tests | Update singleton logic to respect provided URL/opts on subsequent calls. |
| T15 | todo | Await disconnect when swapping DistributedLockService instances | Comment: "disconnecting… without awaiting" | DistributedLockService getDistributedLockService | requires new tests | Make disconnect async/awaited before instantiating replacement client. |
| T16 | todo | Simplify completed-flag duplication in PlanQueueManager | Comment: style | PlanQueueManager completion logic | update existing tests | Refactor to avoid redundant completed flags while preserving behavior. |
