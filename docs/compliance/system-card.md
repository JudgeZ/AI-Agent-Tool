---
# System Card – OSS AI Agent Tool

This system card summarizes how data flows through the platform, how mitigations from the [Security Threat Model](../SECURITY-THREAT-MODEL.md) apply, and how large language models (LLMs) are orchestrated.

## 1. Purpose & Scope
- **Goal:** Provide an auditable, multi-agent coding assistant that runs locally or in enterprise environments.
- **Primary users:** Developers, reviewers, and operators configuring automations and approving agent actions.
- **Version:** Matches the STRIDE analysis dated in `docs/SECURITY-THREAT-MODEL.md`.

## 2. High-level data flow
1. **User / CLI / GUI** submits plans or tool requests via the Gateway API.
2. **Gateway API (Go)** authenticates the caller (OAuth 2.1 + PKCE), validates payloads, and forwards the request to the Orchestrator over mTLS.
3. **Orchestrator (TypeScript)** schedules steps on agents/tools, persists state in Postgres, and emits traces to Langfuse/Jaeger.
4. **Agents & Tools** execute sandboxed actions (repo access, testing, provider calls) and return structured outputs.
5. **Message Bus (RabbitMQ/Kafka)** delivers asynchronous jobs and approval workflows between services.
6. **Data Stores** (Postgres, Redis, secrets backend, artifact storage) retain plan data for up to 30 days per the [Retention Policy](./retention-policy.md).
7. **Providers / LLMs** are invoked via capability-scoped API keys defined in `docs/model-authentication.md` and recorded in Langfuse traces.

## 3. Data categories & handling
| Data | Purpose | Storage | Controls |
| --- | --- | --- | --- |
| Plan metadata & steps | Coordinate agent execution | Postgres / file-backed plan store | Request validation, encrypted storage, 30-day retention |
| Approval records | Capture human-in-the-loop decisions | Postgres | Audit tables, structured logs with trace IDs |
| Tool execution traces | Debugging, accountability | Jaeger / Langfuse | Redaction of secrets, 30-day default retention |
| Provider credentials | Authenticate to LLMs/tools | Secrets backend (Local/Vault) | Envelope encryption, short-lived tokens |
| Artifacts (logs, patches) | Reproducibility | Encrypted artifact store | CMEK enforced, retention aligned with plan artifacts |

See [`docs/compliance/data-inventory.md`](./data-inventory.md) for the authoritative inventory.

## 4. Mitigations mapped to STRIDE
- **Spoofing / Tampering:** OAuth 2.1 + PKCE, mutual TLS, and schema validation prevent forged requests (see STRIDE table rows for Gateway/Orchestrator).
- **Repudiation:** Structured audit logs, Langfuse trace IDs, and append-only Postgres tables provide non-repudiation of plan and approval events.
- **Information Disclosure:** Default-deny CORS, DLP scanning before context sharing, and encrypted storage mitigate sensitive data exposure.
- **Denial of Service:** Per-token/IP rate limiting, queue backpressure, and autoscaling safeguards maintain availability.
- **Elevation of Privilege:** Capability-based agent permissions, sandboxed tool containers, and OPA policies enforce least privilege.

## 5. Model usage
- **Supported providers:** OpenAI, Anthropic, Google, Azure OpenAI, AWS Bedrock, Mistral, OpenRouter, and local models via Ollama (see [`docs/model-authentication.md`](../model-authentication.md)).
- **Prompt handling:** Inputs/outputs are logged to Langfuse with optional redaction; secrets are filtered before logging per STRIDE mitigations.
- **Human oversight:** High-risk actions require explicit approval; denial/approval is logged and retained for 30 days.
- **Evaluation:** Plans are observed via Jaeger/Langfuse metrics to detect regressions or anomalous behavior.

## 6. Responsible release & monitoring
- **Change control:** Releases require signed container images (cosign) and SBOM verification.
- **Monitoring:** Observability spans carry actor IDs and capability labels for auditability.
- **Incident response:** Runbooks in `docs/runbooks/` outline gateway, orchestrator, and indexer procedures.
- **Updates:** Review the system card whenever the STRIDE model, retention settings, or provider list changes.

---
