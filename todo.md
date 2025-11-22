# TODO Tasks

**How to maintain this file**
- Keep task IDs sequential starting from `T1`; renumber the table when adding or removing tasks to avoid gaps.
- When a task is completed and merged, remove its row entirely; keep only outstanding work here.
- Preserve the column structure and concise descriptions so tasks remain actionable with locations and testing expectations.
- When adding a task, include enough detail in `notes` to implement later and set `test_impact` based on expected changes.
- Before adding a new task, check for duplicates or overlaps; consolidate related items into a single entry and update the `source`/`notes` fields to reference all relevant comments.
- Use the column descriptions below to keep data consistent and include file paths, line ranges, and a brief implementation plan for each task.

**Column descriptions**
- `id`: Sequential task identifier (`T1`, `T2`, …) with no gaps.
- `status`: `todo` until implemented; remove the row once done/merged.
- `description`: One-line actionable summary of the change requested.
- `source`: Who requested it and short quote/context.
- `file_location`: Primary file or module needing changes.
- `line_numbers`: Approximate line range or section to edit for quick navigation.
- `impl_plan`: One to two bullet steps summarizing the intended approach.
- `test_impact`: Expected testing needs (`requires new tests`, `update existing tests`, `manual only (justify)`).
- `notes`: Extra context, edge cases, or related tasks/comments.

| id | status | description | source | file_location | line_numbers | impl_plan | test_impact | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | todo | Add rate limiting/per-session limits for lock acquisition and file operations | Reviewer: "Rate Limiting Not Considered" | services/orchestrator/src/services/FileLockManager.ts; services/orchestrator/src/tools/core/FileSystemTool.ts | L80-L170; L50-L220 | Define per-session quotas, enforce before lock/file ops, and surface throttling errors. | requires new tests | Design per-session quotas to cap lock attempts/file actions; add enforcement hooks and tests. |
| T2 | todo | Add audit logging for file operations and approvals | Reviewer: "Audit Logging Incomplete" | services/orchestrator/src/tools/core/FileSystemTool.ts | L60-L230 | Emit structured logs for actions (session, trace, path) and approvals, ensuring no secrets logged. | requires new tests | Emit structured logs with session/trace/action details for sensitive operations. |
| T3 | todo | Document rename coalescing race window in watcher | Reviewer suggestion | services/orchestrator/src/services/FileWatcherService.ts | L120-L190 | Add docstring/README note describing rename/replace timing >500ms and resulting behavior. | manual only (justify) | Explain behavior when rename/replace events are >500ms apart and potential missed coalescing. |
| T4 | todo | Add tests for invalid JSON history, concurrent lock acquisition, timeout handling | Reviewer: "Missing Error Path Tests" | services/orchestrator/src/services/FileLockManager.test.ts | L30-L170 | Write tests covering schema validation failures, simultaneous acquisitions, and timeout paths. | requires new tests | Cover schema validation failures, simultaneous acquisitions, and timeout paths. |
| T5 | todo | Propagate trace IDs / spans for lock and file operations | Reviewer: "Missing Tracing" | services/orchestrator/src/services/FileLockManager.ts; services/orchestrator/src/tools/core/FileSystemTool.ts | L40-L260; L50-L230 | Thread trace/span context through lock acquisition and file actions; ensure logging carries IDs. | manual only (justify) | Thread trace/span context through lock acquisition and file actions for observability. |
| T6 | todo | Replace unsafe `as` assertion in FileWatcherService entries iteration | Reviewer: TS best practices | services/orchestrator/src/services/FileWatcherService.ts | L130-L170 | Swap cast for typed iteration or type guard while keeping behavior. | update existing tests | Use typed iteration or type guard instead of casting when processing watcher entries. |
| T7 | todo | Add ADR/README for distributed file locking semantics | Reviewer: Documentation | docs/ or services/orchestrator/README.md | N/A | Draft ADR/README covering lock scope, TTL/renewal, and distributed behaviors. | manual only (justify) | Document lock scope, TTL/renewal expectations, and distributed behaviors. |
| T8 | todo | Avoid dual Redis clients; reuse DistributedLockService client or document separation | Reviewer: Blocking issue | services/orchestrator/src/services/FileLockManager.ts | L30-L120 | Reuse singleton client from DistributedLockService or justify separate client with config/docs/tests. | requires new tests | Consolidate Redis client usage or justify separation with configuration/tests. |
| T9 | todo | Make lock acquisition/history persistence atomic or release on persist failure | Reviewer: "lock leak if persist fails" | services/orchestrator/src/services/FileLockManager.ts | L100-L200 | Wrap persistence with rollback/release on failure to avoid leaked locks; add regression tests. | requires new tests | Ensure failure to persist history rolls back or releases lock to avoid leak. |
| T10 | todo | Make 30s lock TTL configurable/extendable | Reviewer: "TTL may be too short" | services/orchestrator/src/services/FileLockManager.ts | L80-L150 | Introduce configurable/renewable TTL with validation; update acquisition logic and tests. | requires new tests | Introduce configuration or renewal mechanism for lock TTL with validation. |
