---
# Data Retention Policy

## Summary
- **Default retention:** 30 days unless overridden by tenant configuration.
- **Scope:** Applies to all telemetry, plan history, approvals, and model interaction logs.

## Retention Rules
| Data Type | System | Default Retention | Override Policy |
|-----------|--------|-------------------|-----------------|
| Plan state & events | Orchestrator Postgres | 30 days | Tenant-configurable via `RETENTION_PLAN_EVENTS_DAYS` |
| Approval history | Orchestrator Postgres | 30 days | Same as plan state |
| Queue metrics | Prometheus | 14 days | Depends on monitoring backend |
| Observability traces | Jaeger/OTLP store | 30 days | Configured per environment |
| Secrets | Local/Vault | Until revocation | Manual deletion/rotation |

## Enforcement Procedures
1. Scheduled jobs purge expired records.
2. Observability stores enforce retention via backend settings.
3. Compliance Advisor audits retention quarterly.

## Exceptions
- Long-term storage requires documented business justification and DPO approval.
- Legal hold requests supersede standard retention until resolved.

---
