
# Codex Master Plan — OSS AI Agent Tool
_Date: 2025-10-29_

This document is a **fully‑specified execution plan for Codex** to plan and build the **OSS AI Agent Tool** from start to finish. It dictates **which coding language** to use for each component, how to phase the work, and which **CI/CD** operations must run per phase. It also states **what is already done** in this repository so Codex can focus on next steps.

---

## 0) Current State — What is **Done**
The following capabilities, files, and workflows already exist in the repo and should be reused/extended (do **not** re‑implement):

**Core services**
- `apps/gateway-api/` — **Go** HTTP server with SSE (`/events`), health (`/healthz`), OAuth routes (`/auth/...`), and OIDC helpers with audit logging + PKCE enforcement (`internal/gateway/auth.go`).
- `services/orchestrator/` — **TypeScript/Node** orchestrator with:
  - `/plan` endpoint and OTel hooks (`src/index.ts`, `src/otel.ts`).
  - **Provider registry** containing production-grade connectors for OpenAI, Anthropic, Google/Gemini, Azure OpenAI, AWS Bedrock, Mistral, OpenRouter, and Local/Ollama with retry/timeouts + secret loading (`src/providers/*`).
  - **SecretsStore** abstraction (`LocalFileStore`, `VaultStore` stubs) plus encrypted local keystore + OAuth/OIDC controllers with audit trails (`src/auth/*`).
  - **Plan Tool** persists `.plans/<id>/plan.json|md`, annotates capabilities/timeouts, and streams SSE step events (`src/plan/planner.ts`, `src/plan/events.ts`).
  - **Plan execution runtime** with typed queue contracts, RabbitMQ + Kafka adapters, plan state store, retry/dead-letter handling, and queue depth metrics (`src/queue/*`).
  - **AgentLoader** parses per‑agent `agent.md` with YAML front‑matter (`src/agents/AgentLoader.ts`).
  - Config loader (`src/config.ts`) including **consumer|enterprise** mode and **RabbitMQ|Kafka** selection.
  - gRPC proto for tool execution contracts (`src/grpc/agent.proto`).
- `services/indexer/` — **Rust** skeleton for symbolic indexing (tree‑sitter/LSP to be added).
- _(Deferred)_ Memory/cache glue to be revisited once orchestrator scale requires a dedicated service.
- `apps/cli/` — **TypeScript** CLI (`ossaat`) with:
  - `ossaat new-agent <name>` — scaffolds `agents/<name>/agent.md` from template
  - `ossaat plan "<goal>"` — creates `.plans/<id>` artifacts
- `apps/gui/` — **Tauri (Rust)** + **SvelteKit (TypeScript)** desktop shell with live plan timeline, approvals modal, and SSE streaming (`src/lib/components/*`).

**Deployment & Ops**
- **Dockerfiles** for gateway‑api (Go), orchestrator (Node), indexer (Rust).
- **Makefile** with `build`, `push`, `helm-install`, `helm-kafka`, `helm-rabbit` targets.
- **Docker Compose:** `compose.dev.yaml` and `docker-compose.prod.yaml`.
- **Helm chart:** `charts/oss-ai-agent-tool/` (gateway, orchestrator, Redis, Postgres, RabbitMQ, Kafka toggle, Jaeger, Langfuse, HPA, NetworkPolicy, PodSecurityContext).
- **Docs:** `docs/agents.md`, `docs/ci-cd.md`, `docs/consumer-enterprise-modes.md`, `docs/model-authentication.md`, `docs/providers-supported.md`, `docs/planner.md`, `docs/configuration.md`, `docs/routing.md`, `docs/docker-quickstart.md`, `docs/kubernetes-quickstart.md`, **STRIDE** at `docs/SECURITY-THREAT-MODEL.md`.
- **Architecture docs:** `docs/architecture/overview.md`, `context-engine.md`, `data-flow.md`, ADRs under `docs/architecture/adr/*`.
- **CI/CD:** `.github/workflows/ci.yml`, `release-images.yml` (cosign + CycloneDX SBOMs), `release-charts.yml`, `security.yml` (Trivy fs/config + image; CodeQL; Semgrep; gitleaks), `release-drafter.yml`; configs `.github/release-drafter.yml`, `renovate.json`.
- **Project name & packaging:** rebranded to **OSS AI Agent Tool** throughout; container repo prefix `ghcr.io/<owner>/oss-ai-agent-tool`.

**Do not re‑implement these; extend them.**

---

## 1) Component→Language Map (binding)

| Component / Artifact | Language / Tech | Rationale |
|---|---|---|
| **Gateway API** (`apps/gateway-api`) | **Go** (net/http) | Minimal latency & footprint; strong SSE performance; easy static binary. |
| **Orchestrator** (`services/orchestrator`) | **TypeScript/Node 20** (Express) + **OpenTelemetry** | Fast dev velocity; rich SDK support for providers; first‑class OTel/HTTP. |
| **Message bus adapters** (inside orchestrator) | **TypeScript** (amqplib for RabbitMQ; kafkajs for Kafka) | Single language for orchestration; pluggable adapters via common interface. |
| **Provider registry** (`src/providers/*`) | **TypeScript** | Consistent with orchestrator; leverage provider SDKs. |
| **Secrets & OAuth** (`src/auth/*`) | **TypeScript** + **Go** (gateway OAuth endpoints) | Orchestrator stores tokens; gateway handles OAuth flows & redirects. |
| **Indexer** (`services/indexer`) | **Rust** (tree‑sitter/LSP crates) | Performance for AST/graph; lower memory; safe concurrency. |
| **Memory/Cache glue** | **TBD** | Currently handled inside the orchestrator. A dedicated service will be re-evaluated post-MVP. |
| **GUI** (`apps/gui`) | **Tauri (Rust)** shell + **SvelteKit (TypeScript)** | Desktop packaging + modern reactive UI; SSE native. |
| **CLI** (`apps/cli`) | **TypeScript** (esbuild) | Cross‑platform scripting, reusing orchestrator utils. |
| **Policies** (`infra/policies/*.rego`) | **Rego (OPA)** | Declarative, auditable capability enforcement. |
| **K8s/Helm** (`charts/*`) | **Helm YAML** | Standard for K8s packaging and enterprise ops. |
| **Docs** (`docs/*`) | **Markdown + Mermaid** | Living docs; diagrams as code. |
| **Protocols** (`*.proto`) | **Protobuf** | Typed cross‑language contracts for inner loop. |

---

## 2) Architectural Contracts (do not violate)
- **Streaming:** SSE to GUI; WebSockets only for truly bidirectional features.  
- **Dual Loop:** gRPC/HTTP for **inner loop**; RabbitMQ or Kafka for **outer loop** (both supported).  
- **Security:** OAuth 2.1 + PKCE; secrets in **SecretsStore**; least‑privilege tools; OPA policy gates; sandboxed tools; default‑deny egress; non‑root containers.  
- **Context:** hybrid (symbolic + semantic + temporal); minimal, ACL‑checked, redacted.  
- **Observability:** OpenTelemetry traces for every step; content capture OFF by default; Jaeger and Langfuse.  
- **Compliance:** DPIA readiness; retention ≤ 30 days unless configured; per‑tenant encryption (enterprise).

---

## 3) Phased Delivery Plan (with CI/CD operations)

### Phase 0 — Baseline (✅ Done)
**Goal:** Provide runnable skeleton, Docker/K8s deploy, CI/CD foundation, and security scans.  
**Artifacts (done):** See §0.  
**CI/CD:** All core workflows exist and are wired to PRs/tags; security scanning runs on PRs and weekly.  
**Definition of Done:** Baseline passes CI; images can be built locally; chart lint succeeds.

---

### Phase 1 — MVP Inner Loop & Providers (✅ Completed)
**Goal:** Make the orchestrator useful with real model calls, a stable inner loop, and job planning.

**Delivered:**
- Production model connectors for OpenAI, Anthropic, Google/Gemini, Azure OpenAI, AWS Bedrock, Mistral, OpenRouter, and Local/Ollama with retries, timeouts, and `SecretsStore` integration (`services/orchestrator/src/providers/*`).
- Typed inner-loop contracts: the gRPC proto plus comprehensive `zod` validation for plan, events, and tool I/O schemas (`services/orchestrator/src/grpc/agent.proto`, `services/orchestrator/src/plan/validation.ts`).
- Planner + CLI streaming: plan files now include capability labels, approvals, and SSE step events that power both CLI and GUI timelines (`services/orchestrator/src/plan/planner.ts`, `services/orchestrator/src/plan/events.ts`).

**Validation & CI/CD:** Provider/unit tests run in `ci.yml`, negative-path auth tests guard the connectors, and security workflows remain unchanged.

**Status:** ✅ Done — orchestrator inner loop issues real completions, enforces approvals, and emits structured telemetry.

---

### Phase 2 — Outer Loop & Consumer Mode polish (✅ Completed)
**Goal:** Durable job processing, RabbitMQ adapter, local-first UX, and OAuth where available.

**Delivered:**
- Queue runtime with shared `QueueAdapter` contracts, RabbitMQ implementation, and plan state store + retry/dead-letter metrics (see `services/orchestrator/src/queue/*`).
- Consumer-mode auth improvements: loopback OAuth routes, encrypted LocalKeystore, and audited SecretsStore operations across orchestrator + gateway (`services/orchestrator/src/auth/*`, `apps/gateway-api/internal/gateway/auth.go`).
- GUI enhancements covering SSE timelines, approval modal, and diff-ready step rendering so users can approve/deny capabilities in real time (`apps/gui/src/lib/components/*`).

**Validation & CI/CD:** Integration tests exercise RabbitMQ/Kafka flows and GUI stores inside `ci.yml`; Playwright smoke + OAuth tests run in `security.yml` where applicable.

**Status:** ✅ Done — consumer workflows survive restarts, approvals are enforced via UI, and secrets stay encrypted locally.

---

### Phase 3 — Enterprise Mode & Kafka (⏳ In Progress)
**Goal:** Multi-tenant, Kafka backbone, Vault secrets, and OIDC SSO.

**Current progress:** Kafka adapter + tests landed in `services/orchestrator/src/queue/KafkaAdapter.ts`, so the remaining focus is observability (lag metrics/HPA wiring), enterprise secrets, and tenant-aware identity/compliance guardrails.

**Epics & Tasks**  
- **E3.1 Kafka Adapter (TypeScript)**
  - ✅ T3.1 Implement **Kafka** adapter using **kafkajs** with compacted topics for job state (`services/orchestrator/src/queue/KafkaAdapter.ts`).
  - ⏳ T3.2 Add **HPA** metrics (queue depth lag) and dashboards (Helm + Grafana overlays).
  - **Acceptance:** Swap RabbitMQ↔Kafka via Helm values; queue autoscaling effective.

- **E3.2 Secrets & Identity**  
  - T3.3 Implement **Vault** or cloud secrets backend for token storage; rotate tokens.  
  - T3.4 OIDC SSO for the web/desktop (enterprise).  
  - **Acceptance:** Tenant‑scoped tokens; audit trails include tenant + actor.

- **E3.3 Compliance & Retention**  
  - T3.5 Enforce **data retention** & **content capture OFF** by default; per‑tenant keys (CMEK).  
  - T3.6 Produce **system card** & DPIA artifacts in `docs/compliance/`.  
  - **Acceptance:** Compliance checklist passes; retention enforced in CI policy tests.

**CI/CD Operations (Phase 3)**  
- **release-charts.yml:** publish chart versions; require environment approvals.  
- **security.yml:** IaC scans cover Kafka and Vault charts; failing HIGH/CRITICAL blocks merge.  
**Definition of Done:** Enterprise mode deploys via Helm with Kafka, Vault, OIDC; compliance docs complete.

---

### Phase 4 — Indexing, Tools, and Multi-Agent
**Goal:** Hybrid context (symbolic + semantic + temporal), MCP tools, multi-agent execution.

**Epics & Tasks**  
- **E4.1 Indexer (Rust)**  
  - T4.1 Integrate **tree‑sitter** for supported languages; build symbol graph API (gRPC).  
  - T4.2 Add semantic embeddings (call into orchestrator embedding provider).  
  - T4.3 Temporal layer: feed git diffs/CI failures to orchestrator context.  
  - **Acceptance:** “Where is auth?” queries return precise, recent locations.

- **E4.2 MCP Tools & Sandboxing**  
  - T4.4 Implement MCP adapters (repo ops, test runner, browser) with capability annotations.  
  - T4.5 Sandbox with container/WASM, read‑only FS, network allow‑lists; approvals for `write` & `egress`.  
  - **Acceptance:** Tool execution records capability & policy grants; violation tests pass.

- **E4.3 Multi-Agent Orchestration**  
  - T4.6 Orchestrator runs **planner → code‑writer → tester → auditor** in a fan‑out/fan‑in graph.  
  - **Acceptance:** Complex refactor PRs (multi‑file) created with tests and security checks.

**CI/CD Operations (Phase 4)**  
- **ci.yml:** Rust unit tests for indexer; contract tests for MCP tools.  
- **security.yml:** sandbox bypass tests; Semgrep policies for dangerous patterns.  
**Definition of Done:** Context engine live; multi‑agent flows create PRs with passing tests.

---

### Phase 5 — Performance & Cost, Ecosystem
**Goal:** Meet performance SLOs, optimize costs, expand integrations.

**Epics & Tasks**  
- **E5.1 Performance**  
  - T5.1 Implement **prompt+retrieval caching**; track hit‑rate and token spend.  
  - T5.2 Ensure p95 TTFT ≤ 300ms (LAN), p95 RPC < 50ms via benchmarks.  
  - **Acceptance:** Dashboards show SLOs green for 7 consecutive days.

- **E5.2 DevEx & Ecosystem**  
  - T5.3 **VS Code extension** (TypeScript) speaking MCP to orchestrator.
  - T5.4 Public **SDKs** (TS/Go/Rust) for tool authors; contract tests.  
  - **Acceptance:** At least two external tools integrated via MCP; docs complete.

**CI/CD Operations (Phase 5)**  
- **release-images.yml:** build multi‑arch images; keep signing + SBOMs.  
- **security.yml:** perf‑budget tests; Trivy is non‑blocking for MEDIUM.  
**Definition of Done:** SLOs achieved; ecosystem integrations live; docs & examples polished.

---

## 4) CI/CD Pipeline (authoritative)

- **PRs** → `ci.yml` (build/test), `security.yml` (Trivy fs/config + image, Semgrep, gitleaks), `release-drafter.yml` (update draft).  
- **Tags `v*`** → `release-images.yml` (build, push GHCR, **cosign sign**, **CycloneDX SBOM**), `release-charts.yml` (lint, package, release to Pages + GHCR OCI).  
- **Schedules** → `security.yml` weekly; CodeQL also weekly.  
- **Gates:** block on failing tests, HIGH/CRITICAL vulns, secrets found, or code‑scanning alerts; require environment approvals for prod deploy.

---

## 5) Coding Standards & Best Practices

- **TypeScript:** strict mode; `zod` schema validation; no `any`; dependency injection for side effects; unit + integration tests.  
- **Go:** small handlers; context timeouts; SSE flush; structured logs.  
- **Rust:** clippy + rustfmt; no unsafe; cancellation‑aware async.  
- **Security:** OPA policy for tool capabilities; sandbox all tools; secrets never logged; TLS everywhere; runAsNonRoot; read‑only root FS.  
- **Docs:** Diátaxis; run link checks and doc tests in CI.  
- **Observability:** span attributes for model/provider, token counts, cache hits, queue depth; correlate trace‑ids to commits and PRs.

---

## 6) Acceptance Gate (per PR)
- Plan JSON attached to PR (for agent‑driven changes).  
- Tests pass (unit/integration).  
- Security scanning clean (no HIGH/CRITICAL; no secrets).  
- Docs updated for user‑visible changes.  
- Performance impact noted (cache/SLOs).  
- Rollback plan included (or no‑op).

---

## 7) Immediate Next Work Items (for Codex)

1. **Finish Kafka observability + autoscaling** — expose lag/depth metrics to Prometheus, wire Grafana dashboards, and add Helm values for queue-driven HPAs (`services/orchestrator/src/queue/KafkaAdapter.ts`, `charts/oss-ai-agent-tool/templates/*`).
2. **Ship Vault-backed SecretsStore** with token rotation + policy enforcement for multi-tenant deployments (`services/orchestrator/src/auth/SecretsStore.ts`, `services/orchestrator/src/auth/VaultStore.ts`, Helm secrets wiring).
3. **End-to-end OIDC SSO** — connect gateway OIDC helpers, orchestrator session store, and GUI auth surfaces for enterprise sign-on (`apps/gateway-api/internal/gateway/auth.go`, `services/orchestrator/src/auth/OidcController.ts`, `apps/gui/src/lib/stores/session.ts`).
4. **Retention + tenant isolation guardrails** — enforce 30-day max history for plan artifacts + queue state, encrypt per-tenant data, and add policy tests (`services/orchestrator/src/queue/PlanStateStore.ts`, `services/orchestrator/src/plan/events.ts`).
5. **Compliance package** — author system card + DPIA under `docs/compliance/`, document audit/a11y controls, and link from `docs/SECURITY-THREAT-MODEL.md`.

---

## 8) Non-goals (right now)
- Voice/chat WS; collaborative editing; hosted marketplace. Reserve for later phases.  
- Fine-tuning/training pipelines; this tool focuses on orchestration and DevEx.

---

_End of plan._
