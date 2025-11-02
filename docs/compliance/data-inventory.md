---
# Data Inventory

| Data Category | Description | Location | Legal Basis | Retention |
|---------------|-------------|----------|-------------|-----------|
| Plan metadata | Plan IDs, goals, timelines | Orchestrator Postgres | Legitimate interest | 30 days (default) |
| Approval records | Approver identifiers, decisions | Orchestrator Postgres | Legitimate interest | 30 days |
| Provider credentials | API keys, tokens | Secrets backend (Local/Vault) | Contractual obligation | Until revoked |
| Execution traces | Tool invocations, trace IDs | Observability backend (Jaeger/Langfuse) | Legitimate interest | 30 days |

## Notes
- Update this table when new data categories are introduced.
- Ensure retention aligns with documented policies and tenant agreements.

---
