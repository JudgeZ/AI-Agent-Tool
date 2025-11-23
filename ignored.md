# Ignored Tasks

**How to maintain this file**
- Keep task IDs sequential starting from `I1`; renumber the table when adding or removing tasks to avoid gaps.
- Record only tasks that have been explicitly declined (e.g., would reduce security, violate AGENTS.md, or create unacceptable risk).
- Document a clear reason for ignoring each task and the conditions under which it should be revisited.
- When an ignored task becomes actionable, move it to `todo.md` (with a new `T` ID) and remove it from this table.
- Preserve concise descriptions and avoid duplicate entries; consolidate overlapping requests and capture the rationale in `notes`.

**Column descriptions**
- `id`: Sequential task identifier (`I1`, `I2`, …) with no gaps.
- `status`: Always `ignored` for tasks captured here.
- `description`: One-line summary of the declined change.
- `source`: Who requested it and short quote/context.
- `file_location`: Primary file or module the request targeted.
- `line_numbers`: Approximate line range or section to reference.
- `reason`: Why the task was declined (security, correctness, or policy rationale).
- `revisit_triggers`: Specific conditions under which to reevaluate the task.
- `notes`: Extra context, related tasks, or follow-up considerations.

| id | status | description | source | file_location | line_numbers | reason | revisit_triggers | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| I1 | ignored | Avoid acquiring locks for read operations to reduce contention | Reviewer: "acquiring lock for read creates unnecessary contention" | services/orchestrator/src/tools/core/FileSystemTool.ts | L103-L140 | Read locks preserve consistency and prevent torn reads during concurrent writes; removing them would trade safety for throughput. | Reevaluate if read operations become side-effect free and a validated stale-read strategy is available. | See AGENTS.md security guidance; revisit alongside any lock/consistency model changes. |
| I2 | ignored | Skip history persistence when releasing restored locks | Reviewer: "Redundant history persistence during lock restore" | services/orchestrator/src/services/FileLockManager.ts | wrapRelease | Persisting history on release ensures Redis and in-memory state stay aligned after restores; skipping would risk stale history and violates auditability guidance. | Revisit if release persistence causes measurable Redis load and an alternative cleanup mechanism is introduced. | Current persistence is lightweight and keeps history accurate after restores. |
| I3 | ignored | Change initial `approved` initialization in FileSystemTool | Reviewer: "The initial value of approved is unused" | services/orchestrator/src/tools/core/FileSystemTool.ts | L150-L190 | Defaulting to `true` documents the optimistic path and is used when approvals are available; changing adds no functional benefit. | Revisit if approval logic is refactored or default behavior changes. | Initial value clarifies intent and is overwritten when review is required. |
