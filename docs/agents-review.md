# Code Review: Agent Profiles (`agents/*`)

This document summarizes the findings of the code review for all agent profile definitions.

## Summary

The agent profiles provide clear, well-structured definitions of agent capabilities, approval policies, and operating procedures. The YAML front-matter is consistent, and the Markdown body provides actionable guidance. However, gaps exist in YAML validation, capability coverage, model configuration validation, and documentation consistency.

**Overall Status:** Good (with improvements needed for production)

## Findings by Category

### 1. YAML Front-Matter Validation

-   **PASS**: All agent profiles use consistent YAML structure with required fields (name, role, capabilities, approval_policy, model).
-   **NEEDS IMPROVEMENT**: No schema validation on agent load. Invalid YAML or missing fields would cause runtime errors.
-   **NEEDS IMPROVEMENT**: `capabilities` array values not validated against known capability list (repo.read, repo.write, test.run, etc.).
-   **NEEDS IMPROVEMENT**: `approval_policy` keys not validated against capabilities list. Could reference non-existent capabilities.
-   **CRITICAL**: `model.provider` accepts `auto` but no validation that fallback providers are configured.

### 2. Capability Mappings

-   **PASS**: Code Writer has appropriate capabilities for its role: repo.read, repo.write, test.run, plan.read.
-   **PASS**: Architect properly scoped to design work: repo.read, repo.write, plan.read (no test.run needed).
-   **PASS**: Approval policies correctly require human_approval for repo.write across all agents.
-   **PASS**: network.egress consistently denied for agents that don't need external access.
-   **NEEDS IMPROVEMENT**: No agent has `secrets.manage` capability defined, even though it's documented in capabilities table.
-   **NEEDS IMPROVEMENT**: Test Runner agent (if exists) should have test.run but not repo.write to enforce separation of concerns.
-   **CRITICAL**: No audit capability defined for Security Auditor to log findings.

### 3. Approval Policies

-   **PASS**: All agents require human_approval for repo.write (correct for safety).
-   **PASS**: network.egress denied by default (principle of least privilege).
-   **NEEDS IMPROVEMENT**: No differentiation between consumer vs enterprise approval flows. Enterprise might want auto-approval with audit log.
-   **NEEDS IMPROVEMENT**: No approval policy for secrets.manage or other sensitive capabilities.
-   **NEEDS IMPROVEMENT**: No escalation path documented for denied capabilities.

### 4. Model Configuration

-   **PASS**: Code Writer uses temperature=0.2 (appropriate for deterministic code generation).
-   **PASS**: Architect uses routing=high_quality and temperature=0.3 (appropriate for design decisions).
-   **NEEDS IMPROVEMENT**: No validation of provider availability. If `auto` selects unavailable provider, request fails.
-   **NEEDS IMPROVEMENT**: No fallback providers defined. Should specify provider preference order.
-   **NEEDS IMPROVEMENT**: No max_tokens or timeout configured. Could cause expensive/slow requests.
-   **CRITICAL**: No cost limits per agent. High-temperature, long-running tasks could exhaust quotas.

### 5. Observability Configuration

-   **PASS**: Code Writer includes tracingTags: [code-review, safety] for filtering spans.
-   **PASS**: Architect includes tracingTags: [architecture, design].
-   **NEEDS IMPROVEMENT**: Not all agents have tracingTags defined. Should be mandatory for observability.
-   **NEEDS IMPROVEMENT**: No performance budgets (e.g., max execution time per step).

### 6. Documentation Quality

-   **PASS**: All profiles include clear Mission statement explaining agent purpose.
-   **PASS**: Operating procedures provide step-by-step guidance.
-   **PASS**: Guardrails & escalation section documents constraints and when to involve other agents.
-   **PASS**: Key outputs list deliverables.
-   **PASS**: Tooling checklist provides actionable validation steps.
-   **NEEDS IMPROVEMENT**: No examples of good vs bad outputs.
-   **NEEDS IMPROVEMENT**: No troubleshooting section for common failures.
-   **NEEDS IMPROVEMENT**: Cross-references to other agents incomplete (e.g., Code Writer mentions Test Runner but Test Runner doesn't mention Code Writer).

### 7. Consistency Across Agents

Reviewed 9 agent profiles:
- architect
- code-writer
- compliance-advisor
- docs-writer
- evaluator
- performance-engineer
- release-manager
- security-auditor
- test-runner

**Consistent Elements:**
- ✅ YAML front-matter structure
- ✅ Markdown body sections (Mission, Operating procedure, Guardrails, Key outputs, Tooling checklist)
- ✅ Approval policies for repo.write

**Inconsistent Elements:**
- ⚠️  Not all agents have observability.tracingTags
- ⚠️  Model temperature varies (0.2-0.7) without documented rationale
- ⚠️  Some agents use routing=default, others high_quality, no clear policy
- ⚠️  Constraint lists vary in specificity and actionability

### 8. Security Considerations

-   **PASS**: Principle of least privilege applied (agents only have capabilities they need).
-   **PASS**: Human approval required for write operations.
-   **CRITICAL**: No rate limiting per agent. Malicious/buggy agent could spam requests.
-   **CRITICAL**: No capability escalation audit trail. Should log when agent requests denied capability.
-   **NEEDS IMPROVEMENT**: No sandboxing specifications. Should document container/WASM restrictions per agent.
-   **NEEDS IMPROVEMENT**: No data minimization policy. Agents could retrieve excessive context.

## Recommendations (Prioritized)

### Critical (P0) - Security & Validation

1.  **Add JSON Schema Validation**: Create schema for agent profiles and validate on load:
```typescript
const AgentProfileSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  capabilities: z.array(z.enum([
    "repo.read", "repo.write", "test.run", "network.egress", 
    "plan.read", "secrets.manage", "policy.enforce"
  ])),
  approval_policy: z.record(z.enum(["auto", "human_approval", "deny"])),
  model: z.object({
    provider: z.enum(["auto", "openai", "anthropic", "google", ...]),
    routing: z.enum(["default", "high_quality", "low_cost"]),
    temperature: z.number().min(0).max(2)
  }),
  constraints: z.array(z.string()).optional(),
  observability: z.object({
    tracingTags: z.array(z.string())
  }).optional()
});
```

2.  **Add Capability Coverage Test**: Ensure all documented capabilities are used by at least one agent.

3.  **Implement Per-Agent Rate Limiting**: Max 100 requests/hour per agent, configurable per capability.

4.  **Add Cost Budgets**: Define max token spend per agent per day.

5.  **Document Sandbox Requirements**: Specify container securityContext, network policies, and resource limits per agent.

### High (P1) - Production Readiness

6.  **Add Model Fallback Configuration**:
```yaml
model:
  provider: auto
  routing: high_quality
  temperature: 0.3
  fallback_providers:
    - anthropic
    - openai
    - google
  max_tokens: 4000
  timeout_seconds: 30
```

7.  **Mandatory Tracing Tags**: All agents must define observability.tracingTags.

8.  **Add Performance Budgets**:
```yaml
performance:
  max_execution_time_seconds: 300
  max_context_tokens: 10000
  max_retries: 3
```

9.  **Standardize Constraint Format**: Use checklist format for all constraints:
```yaml
constraints:
  - check: "Coverage >80%"
    severity: error
  - check: "Linter passing"
    severity: warning
```

10. **Add Escalation Matrix**: Document which agent to consult for each capability:
```markdown
## Escalation Matrix

| Capability Needed | Escalate To |
|-------------------|-------------|
| network.egress | Security Auditor |
| secrets.manage | Compliance Advisor |
| Breaking changes | Architect + Release Manager |
```

### Medium (P2) - Enhancements

11. **Add Example Workflows**: Include sample plan steps for each agent showing typical usage.

12. **Create Agent Compatibility Matrix**: Document which agents work together and common workflows.

13. **Add Troubleshooting Section**: Common errors and resolutions per agent.

14. **Version Agent Profiles**: Add `version: 1.0.0` field for schema evolution.

15. **Add Consumer vs Enterprise Mode**: Different approval policies per run_mode:
```yaml
approval_policy:
  consumer:
    repo.write: human_approval
  enterprise:
    repo.write: auto_with_audit
```

### Low (P3) - Nice to Have

16. **Generate Agent Registry**: Auto-generate docs/agents/registry.md listing all agents with capabilities.

17. **Add Agent Templates**: Template for creating new agents with required fields.

18. **Implement Agent Metrics**: Track success rate, average execution time, cost per agent.

19. **Add Agent Dependencies**: Explicit `requires` field for agents that depend on others.

## Validation Checklist

Run for each agent profile:

```bash
# Validate YAML syntax
yamllint agents/*/agent.md

# Validate with orchestrator tests
npm test --workspace services/orchestrator -- AgentLoader

# Check for required fields
for agent in agents/*/agent.md; do
  echo "Checking $agent"
  grep -q "^name:" $agent || echo "FAIL: missing name"
  grep -q "^capabilities:" $agent || echo "FAIL: missing capabilities"
  grep -q "^approval_policy:" $agent || echo "FAIL: missing approval_policy"
done

# Validate capability references
# (Check that all capabilities in approval_policy are also in capabilities array)
```

## Agent Profile Template

Recommended template for new agents:

```markdown
---
name: "agent-name"
role: "Human-Readable Role"
version: "1.0.0"
capabilities:
  - capability.one
  - capability.two
approval_policy:
  capability.one: auto
  capability.two: human_approval
  network.egress: deny
model:
  provider: auto
  routing: default
  temperature: 0.5
  fallback_providers: [anthropic, openai]
  max_tokens: 4000
  timeout_seconds: 30
performance:
  max_execution_time_seconds: 300
  max_context_tokens: 10000
  max_retries: 3
observability:
  tracingTags:
    - tag1
    - tag2
constraints:
  - check: "Constraint description"
    severity: error
---

# Agent Name

## Mission

One-sentence purpose statement.

## Operating Procedure

1. Step one
2. Step two
3. Step three

## Guardrails & Escalation

- **Guardrail**: Description
- **Escalation**: When and to whom

## Key Outputs

- Output 1
- Output 2

## Escalation Matrix

| Need | Escalate To |
|------|-------------|
| X | Agent Y |

## Tooling Checklist

- [ ] Validate profile
- [ ] Test with mock plan
- [ ] Document examples

## Examples

### Good Example
[Description]

### Bad Example
[Description and why it's bad]

## Troubleshooting

### Error: X
**Cause**: Y
**Solution**: Z
```

## Cross-Agent Workflow Examples

### Code Change Workflow

1. Architect designs solution → ADR
2. Code Writer implements → PR
3. Test Runner validates → Coverage report
4. Security Auditor reviews → Approval
5. Release Manager deploys → Production

### Security Review Workflow

1. Security Auditor runs STRIDE → Findings
2. Architect updates design → ADR
3. Code Writer applies mitigations → PR
4. Compliance Advisor verifies → Compliance checklist

## Compliance with Architectural Doctrine

| Requirement | Status | Notes |
|-------------|--------|-------|
| Capability-based access | ✅ PASS | All agents define capabilities |
| Approval policies | ✅ PASS | repo.write requires human approval |
| OPA enforcement | ✅ PASS | PolicyEnforcer validates capabilities |
| Least privilege | ✅ PASS | Minimal capabilities per agent |
| Observability | ⚠️  PARTIAL | Not all agents have tracingTags |
| Documentation | ✅ PASS | Clear mission and procedures |
| Validation | ❌ FAIL | No schema validation on load |
| Cost controls | ❌ FAIL | No budget limits per agent |

