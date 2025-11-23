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
| I1 | ignored | Remove locks for read operations to reduce contention | Reviewer: “acquiring lock for read creates unnecessary contention” | services/orchestrator/src/tools/core/FileSystemTool.ts | 121-177 | Retaining read locks prevents torn reads and aligns with security/consistency guidance. | If read operations become performance bottleneck and safety can be preserved via read-write locks. | Documented trade-off; maintains correctness over throughput. |
| I2 | ignored | Skip history persistence when releasing restored locks to reduce Redis writes | Reviewer: “Redundant history persistence during lock restore” | services/orchestrator/src/services/FileLockManager.ts | 300-324 | Persisting on release keeps Redis and in-memory history aligned for audits and recovery; skipping risks stale state. | If Redis write load from lock releases becomes problematic and alternative consistency guarantees are added. | Current persistence is lightweight and keeps restore history consistent. |
| I3 | ignored | Refactor duplicate lock acquisition logic into shared helper | Reviewer: “Duplicate lock acquisition logic” | services/orchestrator/src/services/FileLockManager.ts | 150-230; 330-400 | Duplication keeps acquire vs. restore flows explicit with different metrics/error handling; refactor risk outweighs benefit now. | If future changes require modifying both paths or maintainability degrades. | Consider helper later if behavior converges further. |
