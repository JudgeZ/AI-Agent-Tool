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
| T1 | todo | Persist rate limiter state across orchestrator instances | Reviewer: "Rate limiter state not persisted" | services/orchestrator/src/services/RateLimiter.ts | entire file | Explore Redis-backed limiter shared across instances; keep in-memory fallback. | requires new tests | Current limiter is per-process; follow-up to prevent multi-instance overuse. |
| T2 | todo | Emit metrics for lock operations and rate-limit hits | Reviewer: "Add metrics for lock operations" | services/orchestrator/src/services/FileLockManager.ts | acquireLock / releaseSessionLocks | 70-330 | Add counters/histograms for lock acquire success/failure and rate-limit denials. | requires new tests | Improve observability for contention and outages. |
