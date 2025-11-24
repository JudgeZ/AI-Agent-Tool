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
