# Agents

Agents are modular capabilities that the orchestrator schedules to fulfill plan steps. Each agent profile defines its mission, allowed capabilities, approval requirements, and runtime defaults so that the orchestrator can evaluate whether it is safe to execute a step automatically or needs a human in the loop.

## Where agent profiles live

* **Source of truth:** `agents/<agent-name>/agent.md`
* **Template:** [`docs/agents/templates/agent.md`](./agents/templates/agent.md)
* **Loader:** [`services/orchestrator/src/agents/AgentLoader.ts`](../services/orchestrator/src/agents/AgentLoader.ts)

Agent profiles use Markdown with YAML front-matter. The orchestrator parses the front-matter to configure routing, capabilities, and approval policies, and renders the Markdown body in the GUI for operator guidance.

## Capabilities & approvals

Capabilities are scoped verbs that the orchestrator enforces with policy gates:

| Capability | Purpose | Typical approval policy |
| --- | --- | --- |
| `repo.read` | Read-only filesystem access for the repository | `auto` |
| `repo.write` | Modify files via the MCP repo tool | `human_approval` |
| `test.run` | Execute unit/integration tests within the sandbox | `auto` |
| `network.egress` | Access external services or the public Internet | `deny` unless explicitly granted |
| `plan.read` | Inspect the current plan for context | `auto` |
| `secrets.manage` | Rotate tokens or fetch secrets from the store | `human_approval` |

Approval policies map capability → `auto`, `human_approval`, or `deny`. The orchestrator and [OPA policies](../infra/policies) enforce these decisions before tools run.

## Authoring a new agent

1. Run the CLI scaffolding command:
   ```bash
   aidt new-agent <name>
   ```
   The CLI copies the template, replaces the `name` field, and writes `agents/<name>/agent.md`.
2. Edit the generated profile:
   * Update `role`, `capabilities`, and `approval_policy` to reflect the mission.
   * Choose routing defaults under `model` (`provider`, `routing`, `temperature`). See [Model Authentication](./model-authentication.md) and [Routing](./routing.md) for supported providers and tiers.
   * Document the human-readable guidance under **Mission** and **Process** so operators know how the agent behaves.
3. Commit the new profile alongside any code or configuration changes the agent requires.

Profiles should remain **diff-friendly**: prefer checklists and numbered steps, keep prose concise, and reference other docs when behavior depends on platform configuration.

## Testing agent profiles

The orchestrator includes unit tests that load every profile via the `AgentLoader`. After adding or updating a profile, run:

```bash
npm test --workspace services/orchestrator -- AgentLoader
```

CI runs the same tests automatically. See [CI/CD](./ci-cd.md) for the full pipeline.

## How agents interact with plans

1. A user or the CLI executes `aidt plan "<goal>"`, producing a plan with labeled steps and approval requirements (see [Planner](./planner.md)).
2. The orchestrator assigns each step to an agent whose capabilities satisfy the requirement.
3. When a step triggers `repo.write` or `network.egress`, the orchestrator pauses and awaits the required approval.
4. Operators monitor progress via SSE in the GUI (documented in [GUI Guide](./gui.md)).

Agent guidance should reinforce this lifecycle so that human reviewers can quickly understand what the agent will attempt and what approvals it needs.

## Related guides

* [Configuration](./configuration.md) – environment variables, run modes, and messaging backends that affect agent policies.
* [Security Threat Model](./SECURITY-THREAT-MODEL.md) – STRIDE analysis and mitigations for orchestrator ↔ agent interactions.
* [Docker Quickstart](./docker-quickstart.md) – run the full stack locally for agent development.
* [Kubernetes Quickstart](./kubernetes-quickstart.md) – deploy agents into a cluster using the Helm chart.
