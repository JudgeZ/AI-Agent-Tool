# TODO Tasks

**How to maintain this file**
- Keep task IDs sequential starting from `T1`; renumber the table when adding or removing tasks to avoid gaps.
- Add only actionable tasks that are expected to be implemented; declined items belong in `ignored.md`.
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
| T1 | todo | Add rate limiting/per-session limits for lock acquisition and file operations | Reviewer: "Rate Limiting Not Considered" | services/orchestrator/src/services/FileLockManager.ts; services/orchestrator/src/tools/core/FileSystemTool.ts | L80-L190; L50-L230 | Define per-session quotas, enforce before lock/file ops, and surface throttling errors. | requires new tests | Design per-session quotas to cap lock attempts/file actions; add enforcement hooks and tests. |
| T2 | todo | Add tests for concurrent lock acquisition and timeout handling | Reviewer: "Missing Error Path Tests" | services/orchestrator/src/services/FileLockManager.test.ts | L30-L200 | Write tests covering simultaneous acquisitions and lock timeout paths. | requires new tests | Invalid history and persist rollback are covered; add concurrency and TTL expiry cases. |
| T3 | todo | Propagate trace IDs / spans for lock and file operations | Reviewer: "Missing Tracing" | services/orchestrator/src/services/FileLockManager.ts; services/orchestrator/src/tools/core/FileSystemTool.ts | L40-L270; L50-L230 | Thread trace/span context through lock acquisition and file actions; ensure logging carries IDs. | manual only (justify) | Thread trace/span context through lock acquisition and file actions for observability. |
| T4 | todo | Add ADR/README for distributed file locking semantics | Reviewer: Documentation | docs/ or services/orchestrator/README.md | N/A | Draft ADR/README covering lock scope, TTL/renewal, and distributed behaviors. | manual only (justify) | Document lock scope, TTL/renewal expectations, and distributed behaviors. |
| T5 | todo | Ensure lock manager uses configured Redis URL consistently | Reviewer: "Redis lock URL ignored after first singleton creation" | services/orchestrator/src/services/FileLockManager.ts; services/orchestrator/src/services/DistributedLockService.ts | L20-L120 | Allow injecting configured lock Redis URL or align singleton initialization to honor config overrides. | requires new tests | Avoid mismatched lock Redis endpoints between services by respecting configured URL across singletons. |
| T6 | todo | Clear plan session tracking maps on reset/stop to avoid stale entries | Reviewer: "planSessions/sessionRefCounts not cleaned" | services/orchestrator/src/queue/PlanQueueManager.ts | L400-L470; L600-L640 | Clear planSessions/sessionRefCounts in reset/stop flows and add coverage. | requires new tests | Prevents memory growth when plans never complete or during repeated test runs. |
