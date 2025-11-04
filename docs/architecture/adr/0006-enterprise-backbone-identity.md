# ADR 0006: Enterprise Backbone and Identity Decisions

- Status: Accepted
- Context:
  - Enterprise customers require multi-tenant isolation, durable event retention, and externalised identity/secrets to pass audits.
  - The orchestrator must stream plan-step telemetry to multiple consumers (GUI, observability, policy engines) without losing historical context.
  - Self-managed secrets (local files) and OAuth loopback flows are insufficient for regulated environments that mandate Federated SSO and secret rotation.
- Decision:
  - Treat **Kafka** as the default message backbone in enterprise mode. Helm values and runtime config expose Kafka-specific settings (TLS, SASL, topic partitions/retention) while RabbitMQ remains available for consumer deployments.
  - Use **HashiCorp Vault** as the enterprise secrets backend. The orchestrator supports Kubernetes auth, token renewal, TLS pinning, and lease invalidation so credentials never live on disk.
  - Require **OIDC SSO** for operator authentication. The gateway performs PKCE flow initiation, the orchestrator validates tokens, issues HTTP-only sessions, and maps roles/tenants into OPA policies.
- Consequences:
  - Additional operational dependencies: Kafka brokers, Vault clusters, and OIDC IdPs must be provisioned with TLS certificates and lifecycle management.
  - Configuration surface area grows (Helm values/env vars for Kafka, Vault, OIDC), demanding stronger automation and documentation.
  - Enables enterprise features: tenant-aware policy decisions, secret rotation, and audit-ready identity logs—all prerequisites for SOC2/HIPAA-class compliance.
- Alternatives:
  - Continue using RabbitMQ + file-based secrets + OAuth loopback. Rejected because it lacks multi-tenant guarantees, secret rotation, and enterprise identity integration.
  - Adopt managed cloud equivalents (e.g., AWS MSK + Secrets Manager + Cognito). Deferred; the architecture remains compatible but we prioritise first-party integrations to avoid vendor lock-in.
