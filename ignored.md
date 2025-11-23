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
