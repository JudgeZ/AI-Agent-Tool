
# Codex Master Plan — OSS AI Agent Tool
_Date: 2025-10-29_

This document is a **fully‑specified execution plan for Codex** to plan and build the **OSS AI Agent Tool** from start to finish. It dictates **which coding language** to use for each component, how to phase the work, and which **CI/CD** operations must run per phase. It also states **what is already done** in this repository so Codex can focus on next steps.

---

## 0) Current State — What is **Done**
The following capabilities, files, and workflows already exist in the repo and should be reused/extended (do **not** re‑implement):

**Core services**
- `apps/gateway-api/` — **Go** HTTP server with SSE (`/events`), health (`/healthz`), and OAuth stub routes (`/auth/...`).  
- `services/orchestrator/` — **TypeScript/Node** orchestrator with:
  - `/plan` endpoint and OTel hooks (`src/index.ts`, `src/otel.ts`)
  - **Provider registry** (OpenAI, Anthropic, Google/Gemini, Azure OpenAI, AWS Bedrock, Mistral, OpenRouter, Local/Ollama) — stubs return echoes (`src/providers/*`)
  - **SecretsStore** abstraction (`LocalFileStore`, `VaultStore` stubs) and OAuth controller (`src/auth/*`)
  - **Plan Tool** writes `.plans/<id>/plan.json|md` (`src/plan/planner.ts`)
  - **AgentLoader** parses per‑agent `agent.md` with YAML front‑matter (`src/agents/AgentLoader.ts`)
  - Config loader (`src/config.ts`) including **consumer|enterprise** mode and **RabbitMQ|Kafka** selection
  - gRPC proto placeholder (`src/grpc/agent.proto`)
- `services/indexer/` — **Rust** skeleton for symbolic indexing (tree‑sitter/LSP to be added).
- _(Deferred)_ Memory/cache glue to be revisited once orchestrator scale requires a dedicated service.
- `apps/cli/` — **TypeScript** CLI (`ossaat`) with:
  - `ossaat new-agent <name>` — scaffolds `agents/<name>/agent.md` from template
  - `ossaat plan "<goal>"` — creates `.plans/<id>` artifacts
- `apps/gui/` — **Tauri (Rust)** + **SvelteKit (TypeScript)** placeholder shell with SSE display.

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

### Phase 1 — MVP Inner Loop & Providers
**Goal:** Make the orchestrator useful with real model calls, a stable inner loop, and job planning.

**Epics & Tasks**  
- **E1.1 Providers (TypeScript)**  
  - T1.1 Implement **OpenAI** provider using official SDK; config via `SecretsStore`.  
  - T1.2 Implement **Anthropic** provider via SDK.  
  - T1.3 Implement **Google Gemini** with **OAuth** (consumer) and **Service Account** (enterprise).  
  - T1.4 Implement **Azure OpenAI** (AAD token or API key) and **AWS Bedrock** (IAM).  
  - T1.5 Implement **Mistral**, **OpenRouter**; **Ollama** local HTTP.  
  - **Acceptance:** `POST /chat` returns real completions; negative tests handle auth errors gracefully.

- **E1.2 Inner Loop contracts**  
  - T1.6 Define **gRPC** proto for tool/agent exec (`src/grpc/agent.proto`), generate TS/Go stubs.  
  - T1.7 Add JSON schemas (zod) for **Plan**, **Events**, **Tool I/O** (runtime validation).  
  - T1.9 Align initial plan events with approval gating and emit `queued` only after broker enqueue (✅).  
  - **Acceptance:** Orchestrator invokes a mock tool via gRPC with retries & timeouts.

- **E1.3 Plan Tool**  
  - T1.8 Expand planner to emit **capability labels**, **timeouts**, **approvals**, and **SSE events**.  
  - **Acceptance:** Running `ossaat plan "<goal>"` creates plan + streams events to GUI.

**CI/CD Operations (Phase 1)**  
- **ci.yml:** add unit tests for provider adapters; mock APIs.  
- **security.yml:** Semgrep & gitleaks gate PRs; Trivy config scan runs on chart.  
- **release-images.yml:** (unchanged) builds+signs+SBOMs on tags.  
**Definition of Done:** Providers functional end‑to‑end; planner emits steps & events; docs updated.

---

### Phase 2 — Outer Loop & Consumer Mode polish
**Goal:** Durable job processing, RabbitMQ adapter, local-first UX, and OAuth where available.

**Epics & Tasks**  
- **E2.1 RabbitMQ Adapter (TypeScript)**  
  - T2.1 Define `QueueAdapter` interface: `enqueue(job)`, `ack`, `retry`, `dead-letter`.  
  - T2.2 Implement **RabbitMQ** with **amqplib**; idempotency keys; at‑least‑once semantics.  
  - **Acceptance:** Long-running plan steps resume on restart; queue depth metric exported.

- **E2.2 Consumer OAuth & Secrets**  
  - T2.3 Implement **loopback** OAuth in gateway for providers that support it; store tokens via `LocalFileStore` (encrypted).  
  - T2.4 Add **local keystore encryption** (password‑derived key).  
  - **Acceptance:** User can link a provider via `/auth/<provider>` and run a chat.

- **E2.3 GUI UX**  
  - T2.5 SSE event timeline (plan/run/approval states); diff viewer for file changes.  
  - T2.6 “Approve action” dialog for `repo.write` and `network.egress` steps.  
  - **Acceptance:** End‑to‑end plan→apply→test visible from UI.

**CI/CD Operations (Phase 2)**  
- **ci.yml:** add integration tests with embedded RabbitMQ (docker service).  
- **security.yml:** add Selenium/Playwright smoke for GUI (optional).  
**Definition of Done:** Consumer can run complex plans locally; approvals work; docs updated.

---

### Phase 3 — Enterprise Mode & Kafka
**Goal:** Multi-tenant, Kafka backbone, Vault secrets, and OIDC SSO.

**Epics & Tasks**  
- **E3.1 Kafka Adapter (TypeScript)**  
  - T3.1 Implement **Kafka** adapter using **kafkajs** with compacted topics for job state.  
  - T3.2 Add **HPA** metrics (queue depth lag) and dashboards.  
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

1. **Implement OpenAI & Anthropic providers (real SDKs)** in `services/orchestrator/src/providers/` with secrets from `SecretsStore`. Add unit tests and update docs.  
2. **Define QueueAdapter interface** and **implement RabbitMQ adapter** with idempotent semantics (`services/orchestrator/src/queue/*`). Add metrics endpoints.  
3. **Expand Plan Tool** to stream all step transitions to SSE and label capabilities/timeouts/approvals. Update GUI to render the timeline. (Initial state now `waiting_approval` or `queued` only after enqueue.)  
4. **Add basic “approve action” modal** in GUI for `repo.write`/`network.egress`.  
5. **Write ADRs** for provider auth flows (OAuth vs API key specifics) and queue selection policies.

---

## 8) Non-goals (right now)
- Voice/chat WS; collaborative editing; hosted marketplace. Reserve for later phases.  
- Fine-tuning/training pipelines; this tool focuses on orchestration and DevEx.

---

_End of plan._
