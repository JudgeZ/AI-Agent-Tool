---
# Data Protection Impact Assessment (DPIA) – OSS AI Agent Tool

## 1. Processing overview
- **Controller:** OSS AI Agent Tool project maintainers or tenant operators deploying the stack.
- **Processors/Sub-processors:** Cloud providers hosting the deployment, LLM providers listed in [`docs/model-authentication.md`](../model-authentication.md), and observability vendors such as Langfuse or Jaeger backends.
- **Purpose:** Deliver a multi-agent coding assistant with human-in-the-loop approvals, observability, and compliance reporting.
- **Data subjects:** Developers, reviewers, and operators interacting with the platform.

## 2. Lawful basis for processing
| Processing activity | Lawful basis | Notes |
| --- | --- | --- |
| Executing plans and storing plan metadata | Legitimate interest / contractual necessity | Required to deliver requested automation. |
| Approval workflows and audit logs | Legitimate interest | Ensures accountability for privileged actions. |
| Provider/LLM requests | Contractual necessity | Users request completions from configured providers. |
| Observability traces and metrics | Legitimate interest | Needed to troubleshoot incidents securely. |
| Storage of provider credentials | Contractual necessity | Enables integrations requested by the tenant. |

## 3. Data categories
Refer to the [data inventory](./data-inventory.md) for the canonical list. Key categories include:
- **Plan metadata:** IDs, goals, task descriptions, timestamps.
- **Approval history:** Approver identifiers, decisions, policy labels.
- **Execution traces:** Tool invocation logs, trace IDs, provider responses (redacted as needed).
- **Credentials and secrets:** API keys, OAuth tokens, and CMEK artifacts stored in Vault/local secret stores.

## 4. Necessity & proportionality
- Input validation at the Gateway and Orchestrator enforces minimal required fields and rejects unnecessary data (see [Security Threat Model](../SECURITY-THREAT-MODEL.md)).
- Sandboxed agents and capability-based permissions prevent unrestricted access to repositories or external services.
- Observability captures only structured metadata with optional content redaction to minimize exposure.
- Human approvals are scoped to high-risk capabilities and expire when plan retention windows are reached.

## 5. Retention & deletion
- Defaults follow the [Data Retention Policy](./retention-policy.md): plan state, approvals, and observability traces are deleted after 30 days unless a tenant-specific override is configured.
- Secrets rotation logs stay in sync with plan artifact retention so decryptable material never outlives the artifacts it protects.
- Legal hold or contractual requirements are documented as exceptions and tracked by the Compliance Advisor.
- Automated purge jobs and backend-specific TTL settings enforce the configured retention values.

## 6. Access controls & security measures
- OAuth 2.1 + PKCE for user authentication; service-to-service traffic protected with mTLS certificates rotated via Helm secrets.
- Authorization handled by capability tokens plus OPA/Rego policies; privileged actions require explicit human approval.
- Secrets stored encrypted at rest (Vault or encrypted local files) and mounted read-only to services.
- Structured audit logging with trace IDs ensures tamper-evident records for plan changes, approvals, and tool executions.
- Rate limiting, queue backpressure, and autoscaling mitigate DoS threats, while sandboxed agents and non-root containers reduce elevation-of-privilege risk.

## 7. Risk assessment & mitigations
- **Confidentiality risk:** Mitigated through encryption at rest, DLP scanning, and optional prompt redaction before persisting traces.
- **Integrity risk:** Immutable container images, signed release artifacts, and schema validation prevent tampering.
- **Availability risk:** Multi-queue architecture, health probes, and dead-letter queues keep workflows recoverable.
- **Data subject rights:** Requests are handled via the procedures in `docs/compliance/data-subject-rights.md`; data inventory tables enable locating records for export/erasure.

## 8. Residual risk & approvals
- Residual risk is considered **low** after applying the STRIDE mitigations and retention controls described above.
- Review cadence: annually or when onboarding new providers, data stores, or high-risk capabilities.
- Approvers: Compliance Advisor (primary), Security Team (secondary), Legal Counsel (advisory).

---
