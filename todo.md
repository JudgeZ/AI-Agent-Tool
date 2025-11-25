# TODO Tasks

**How to maintain this file**
- Keep task IDs sequential starting from `T1` as you add new rows; leave existing IDs in place to avoid churn after merges.
- Add only actionable tasks that are expected to be implemented; declined items belong in `ignored.md`.
- When a task is completed and merged, remove its row entirely; keep only outstanding work here.
- Preserve the column structure and concise descriptions so tasks remain actionable with locations and testing expectations.
- When adding a task, include enough detail in `notes` to implement later and set `test_impact` based on expected changes.
- Before adding a new task, check for duplicates or overlaps; consolidate related items into a single entry and update the `source`/`notes` fields to reference all relevant comments.
- Use the column descriptions below to keep data consistent and include file paths, line ranges, and a brief implementation plan for each task.

**Column descriptions**
- `id`: Sequential task identifier (`T1`, `T2`, …); reuse the next available number when adding new tasks.
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
| T1 | todo | Persist workflow records instead of in-memory Map with DI-friendly engine | Reviewer: "WorkflowEngine stores all workflow data in an in-memory Map" | services/orchestrator/src/workflow/WorkflowEngine.ts | 25-95 | Implement Postgres-backed storage for workflows with constructor injection and fall back to in-memory only when DB unavailable | requires new tests | Must avoid global mutable state per AGENTS and preserve audit data across restarts |
| T2 | todo | Persist workflow-plan mapping to survive restarts | Reviewer: "mapping between workflow IDs and plan IDs is stored in in-memory Maps" | services/orchestrator/src/workflow/runtime.ts | 6-36 | Add durable mapping table/repository and refactor runtime to use it | requires new tests | Should align with workflow persistence work |
| T3 | todo | Enforce tenant scoping when listing workflows, treating missing tenantId as non-matching | Reviewer: "workflows without tenantId leak to all tenants" | services/orchestrator/src/workflow/WorkflowEngine.ts | 80-99 | Update list filter to exclude workflows lacking tenantId when a tenant filter is provided and add tests | update existing tests | Depends on workflow storage changes |
| T4 | todo | Add rate limiting to cases/workflows endpoints | Reviewer (CLAUDE): "Add rate limiter to all new endpoints" | services/orchestrator/src/controllers/CaseController.ts; services/orchestrator/src/controllers/WorkflowController.ts | 20-120 | Inject RateLimitStore and enforce configured buckets for list/create routes | requires new tests | Follow existing controller patterns |
| T5 | todo | Add tests for workflow runtime lifecycle and mapping | Reviewer: "runtime.ts has zero test coverage" | services/orchestrator/src/workflow/runtime.ts | n/a | Create vitest suite covering submitWorkflow, resolve approvals, and mapping persistence | requires new tests | Coordinate with workflow persistence changes |
| T6 | todo | Refine dynamic SQL/list validation to avoid unsafe construction | Reviewer (CLAUDE): "Dynamic SQL building needs validation" | services/orchestrator/src/cases/CaseService.ts | 270-310 | Ensure status filters are parameterized and validated; add regression test | update existing tests | Align with new enums |
| T7 | todo | Implement workflow persistence/global state removal per AGENTS guidance | Reviewer (CLAUDE): "Global mutable state: WorkflowEngine singleton and module-level Maps" | services/orchestrator/src/workflow/WorkflowEngine.ts; services/orchestrator/src/workflow/runtime.ts | 25-40 | Refactor to inject engine/runtime dependencies and eliminate module-level mutable Maps | requires new tests | Complements T1/T2 |
