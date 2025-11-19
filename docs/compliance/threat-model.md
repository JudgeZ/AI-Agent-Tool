# Security Threat Model (STRIDE)

This document summarizes the STRIDE analysis for the OSS AI Agent Tool across the gateway, orchestrator, agents, data stores, and deployment surfaces. It complements [Security Scanning](./security-scanning.md), the [System Card](./compliance/system-card.md), and the [DPIA](./compliance/dpia.md) while informing policy decisions in [Agents](./agents.md) and [Configuration](./configuration.md).

## Architecture scope

The model covers the baseline deployment:

* **Gateway API (Go)** – OAuth flows, SSE proxy
* **Orchestrator (TypeScript)** – plan execution, provider calls, tool routing
* **Message bus** – RabbitMQ (default) or Kafka
* **Agent runtime** – MCP tools for repo/test execution
* **Data stores** – Postgres, Redis, secrets backend (local file or Vault)
* **Observability** – Jaeger, Langfuse

Attack surfaces include REST/gRPC endpoints, CLI tooling, Helm/Kubernetes manifests, and supply-chain pipelines (Docker/Helm artifacts).

## STRIDE matrix

| Component | Spoofing | Tampering | Repudiation | Information Disclosure | Denial of Service | Elevation of Privilege |
| --- | --- | --- | --- | --- | --- | --- |
| Gateway API | Enforce OAuth 2.1 + PKCE; mutual TLS for internal calls. | Immutable containers; **signed & encrypted OAuth state cookies**; validate plan/job IDs; input validation. | Structured logs with request IDs, forwarded to OpenTelemetry/Jaeger. | Default-deny CORS; sanitize SSE payloads; DLP on responses. | Rate limits per token/IP; health probes; autoscaling. | Run as non-root; limit capabilities in container; OPA policy before proxying sensitive routes. |
| Orchestrator | mTLS between gateway/orchestrator; signed JWTs for CLI actions. | Zod schema validation on plan/tool payloads; config checksums. | Append-only audit trail in Postgres; Langfuse traces with actor metadata. | Secrets fetched via scoped tokens; redaction before logging. | Circuit breakers on provider calls; queue backpressure metrics. | Capability-based agent execution; sandboxing for tools; least-privilege IAM for provider SDKs. |
| Message Bus | SASL/SCRAM (Kafka) or user/pass (RabbitMQ) with TLS. | Durable queues protected by policy (no arbitrary exchange binding). | Persisted message ACK/NACK with actor IDs. | Encrypt at rest (Kafka) or run in VPC; disable management UI in prod. | Connection limits; dead-letter queues; consumer heartbeats. | Per-queue credentials; deny arbitrary exchange creation. |
| Agents & Tools | Signed plan tokens identifying orchestrator. | Immutable container images; read-only rootfs for tool sandboxes. | Tool execution logs stored with trace IDs. | Secrets mounted read-only; apply DLP/secret scan before context sharing. | CPU/memory quotas per tool pod/container; watchdog timers. | Capabilities gate repo.write/network.egress; human approval required for privileged actions. |
| Data Stores | TLS connections; per-service accounts. | Enable write-ahead log checksums; apply schema migrations via CI. | Audit tables recording who modified secrets/config. | Encrypt secrets at rest (Vault or AES-GCM local file); column-level encryption for tokens. | Connection pools with limits; failover replicas. | Separate DB roles for reader/writer; no superuser in app pods. |
| Supply Chain | Verify cosign signatures before deploy; provenance attestation. | Use reproducible builds; SBOM diffing for releases. | GitHub Actions OIDC with short-lived tokens; log retention per compliance. | Scan images with Trivy; restrict registry access. | Throttle Helm install/upgrade concurrency; watch for resource exhaustion in CI. | Principle of least privilege for CI/CD PATs; branch protection with required reviews. |

## Mitigations & controls

1. **Identity & Access Management**
   * OAuth 2.1 with PKCE for user login.
   * **Secure cookies** using HMAC-SHA256 signing and AES encryption to prevent state tampering.
   * Service-to-service calls use mTLS certificates rotated via Helm secrets.
   * Queue credentials scoped per environment (RabbitMQ user, Kafka SASL user).

2. **Policy enforcement**
   * OPA/Rego policies (see `infra/policies`) evaluate capability tokens before tool execution.
   * Agent profiles declare approval requirements; orchestrator blocks until satisfied.

3. **Secrets management**
   * Consumer mode: encrypted local file store (`config/secrets/local/`).
   * Enterprise mode: HashiCorp Vault integration with short-lived tokens.
   * Automatic DLP/secret scanning prior to embedding or logging content.

4. **Observability & audit**
   * OpenTelemetry spans propagate plan IDs, actor IDs, and capability labels.
   * Langfuse captures prompt inputs/outputs with optional redaction.
   * Audit tables in Postgres track configuration and secret changes.

5. **Resilience**
   * RabbitMQ quorum queues and Kafka replication to survive node loss.
   * Work queues with exponential backoff; dead-letter on repeated failures.
   * Health probes and autoscaling for gateway/orchestrator deployments.

6. **Supply-chain integrity**
   * GitHub Actions sign container images with cosign (keyless).
   * **License compliance:** Automated scanning (`scripts/generate-compliance-report.js`) ensures permissive licensing (Apache-2.0/MIT) and generates SBOMs.
   * CycloneDX SBOMs published for each release; verify against policy.
   * Renovate-managed dependency updates reviewed via CI + security scans.

## Threat scenarios

* **Compromised agent attempting unauthorized network access:** Blocked by `network.egress: deny` policy and sandbox egress filters. Manual approval workflow required to override, recorded in audit trail.
* **Malicious provider response injection:** Zod validation checks schema; responses logged with checksums; SSE sanitization prevents script injection into GUI.
* **Queue credential leak:** Rotate credentials via Helm secrets; revoke via RabbitMQ/Kafka ACLs; monitor unusual connection attempts.
* **Supply-chain poisoning:** cosign verification + SBOM diffing catch tampered images before deployment. Release workflow fails on signature mismatch.

## Review cadence

Revisit the threat model every release cycle or when adding new agents, providers, or messaging backends. Coordinate with the [Security Scanning](./security-scanning.md) pipeline to ensure automated coverage reflects the mitigations above.
