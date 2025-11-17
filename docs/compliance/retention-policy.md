---
# Data Retention Policy

## Summary
- **Default retention:** 30 days unless overridden by tenant configuration.
- **Scope:** Applies to plan state, artifacts, secret rotation history, observability, and model interaction logs.
- **Content capture:** Disabled by default; must be explicitly enabled per tenant.

## Retention Rules
| Data Type | System | Default Retention | Override Policy |
|-----------|--------|-------------------|-----------------|
| Plan state & events | Orchestrator file/Postgres store | 30 days | `RETENTION_PLAN_STATE_DAYS` or `retention.planStateDays` |
| Plan artifacts (encrypted) | `.plans/` CMEK artifacts | 30 days | `RETENTION_PLAN_ARTIFACT_DAYS` or `retention.planArtifactsDays` |
| Secrets + CMEK logs | SecretsStore (VersionedSecretsManager) | 30 days (non-current versions). Automatically raised to match the plan-artifact retention window so CMEK keys remain decryptable for as long as artifacts exist. Set to `0` to disable pruning. | `RETENTION_SECRET_LOG_DAYS` or `retention.secretLogsDays` |
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
