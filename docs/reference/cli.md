# CLI Reference

The desktop installer ships a lightweight CLI (`aidt`) for local workflows. Commands assume they are run from the repository root unless stated otherwise.

```
aidt new-agent <name>
aidt plan <goal...>
```

## Installation

```bash
npm install --global ./apps/cli
```

After installation run `aidt --help` to confirm the binary is on your PATH.

## Commands

### `aidt new-agent <name>`

Scaffolds a new agent profile using `docs/agents/templates/agent.md` as the seed.

- Creates `agents/<name>/agent.md`
- Replaces the front-matter `name` with the supplied value
- Fails if `docs/agents/templates/agent.md` is missing

Example:

```bash
aidt new-agent release-manager
```

### `aidt plan <goal...>`

Creates a plan using the orchestrator planner implementation and prints a human-readable summary.

- Defaults to the goal `"General improvement"` when no text is provided
- Writes nothing to disk; output is streamed to stdout
- Echoes the SSE endpoint for subsequent monitoring (`/plan/<ID>/events`)

Example output:

```
Plan created: plan-92a390d6
Goal: Ship the next milestone
Steps:
  • index_repo (Read repository) [tool=repo_indexer, timeout=120s, auto]
  • apply_changes (Apply repository changes) [tool=code_writer, timeout=300s, requires approval]
Success criteria:
  - All steps complete
SSE stream: /plan/plan-92a390d6/events
```

## Exit Codes

| Code | Meaning |
| - | - |
| `0` | Command completed successfully |
| `1` | Unexpected error (missing template, filesystem errors, planner exception) |

Logs and errors are printed to stderr. Set `AIDT_DEBUG=1` to surface stack traces during troubleshooting.

