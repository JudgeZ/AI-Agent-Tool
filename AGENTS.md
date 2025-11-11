1) Agent roster & responsibilities

Each agent is a modular capability. The Orchestrator composes them into plans and enforces guardrails.

Agent	Core responsibilities	Key outputs
Orchestrator (system)	Plan workflows, choose tools/providers, enforce approvals, stream SSE events, propagate trace IDs.	plan.json, SSE events, job state, audit trail
Architect	Architecture & ADRs, diagrams, component boundaries, technology selection.	/docs/architecture/*, /docs/architecture/adr/*
Code Writer	Minimal, testable diffs, multi‑file edits, refactors; follows language standards.	PRs with code + tests
Indexer	Hybrid context (symbolic/LSP + semantic + temporal); answers structural/semantic queries.	Symbol graph, embeddings, temporal deltas
Test Runner	Unit/integration/property tests; artifact capture; flake control.	Test reports, coverage
Security Auditor	STRIDE, OWASP checks; least‑privilege enforcement; sandbox/egress policy; vuln triage.	Security review notes, policy decisions
Compliance Advisor	DPIA, data taxonomy, retention, model/system cards; AI Act readiness.	/docs/compliance/*
Performance Engineer	TTFT/latency budgets, caching, routing strategies; load tests & dashboards.	Perf dashboards, findings
Docs & UX Writer	Diátaxis docs, CLI & GUI guides, accessibility, screenshots & examples.	/docs/*
Release Manager	SemVer, release notes, cosign signing, CycloneDX SBOMs, Helm packaging, canary & rollback.	Tags, releases, sboms, charts
Evaluator	Golden tasks, regression suites, automatic scoring & quality gates.	Eval reports, gating decisions
2) Architectural doctrine (do not violate)

Dual‑loop orchestration

Inner loop: low‑latency, typed calls (gRPC/HTTP) between orchestrator and tools/agents.

Outer loop: durable jobs & events via RabbitMQ (task routing) or Kafka (event backbone).

Streaming to UI: SSE by default; only use WebSockets for truly bidirectional/voice scenarios.

Hybrid context engine: symbolic (AST/LSP) + semantic (vectors) + temporal (diffs/CI).

Security by default: OAuth 2.1 + PKCE; mTLS; least‑privilege capabilities; OPA/Rego policy gates; sandbox (container/WASM), runAsNonRoot, read‑only root; default‑deny egress.

Data minimization & privacy: ACL checks before retrieval; DLP + secret scanning; content capture OFF by default; retention ≤ 30 days unless configured; tenant keys (CMEK) in enterprise.

Observability first: OpenTelemetry traces for every step; cost & token usage tracked; Jaeger & Langfuse.

Consumer ↔ Enterprise: One codebase; RUN_MODE toggles secrets backend, OAuth callback style, message bus, and policies.

3) Components & languages (binding)
Component	Language / Tech	Reasoning
Gateway API (apps/gateway-api)	Go (net/http)	Fast SSE, small static binary, simple ops
Orchestrator (services/orchestrator)	TypeScript/Node 20 (Express + OTel)	Velocity, rich provider SDKs, JSON schemas
Queue adapters	TypeScript (amqplib for RabbitMQ; kafkajs for Kafka)	Pluggable under a single interface
Provider registry (src/providers/*)	TypeScript	SDK ecosystem, shared config & auth
Indexer (services/indexer)	Rust (tree‑sitter/LSP)	Performance, memory safety, AST precision
Memory/Cache glue (integrated)	TypeScript (future)	Currently handled inside orchestrator; dedicated service deferred
GUI (apps/gui)	Tauri (Rust) + SvelteKit (TS)	Desktop + modern reactive UI; SSE‑friendly
CLI (apps/cli)	TypeScript (esbuild)	Cross‑platform scripting
Policies (infra/policies/*.rego)	Rego (OPA)	Declarative, auditable authorization
K8s packaging (charts/*)	Helm YAML	Enterprise standard
RPC contracts (*.proto)	Protobuf	Typed, multi‑language stubs
4) Knowledge & retrieval rules (what agents must know)

Repo sources: code, docs, ADRs, Helm, workflows, agent profiles.

Operational signals: queue depth, p95 latencies, cache hit rate, error budgets.

Rules:

Enforce ACL before reading; DLP+secret scan before embedding or displaying.

Annotate citations as path@sha and quote minimally.

Limit context to relevant chunks; prefer references over bulk paste.

Memory model: working (per run), episodic (session), semantic (long‑term vectors), with clear expiry & privacy settings.

5) Planning & execution policy

Plan‑then‑execute: every operation starts with a minimal, verifiable plan.

Label steps by capability: {repo.read, repo.write, test.run, network.egress, policy.enforce}.

Approvals required for repo.write and network.egress in consumer mode; enterprise policies may allow automation within guarded scopes.

All steps are idempotent and time‑bounded; retries use exponential backoff; circuit breakers on external calls.

Stream progress to the UI (SSE) with state transitions: waiting_approval → approved → queued → running → completed|failed (non-approval steps start directly at `queued`).

Plan JSON (canonical excerpt)

{
  "id": "plan-<uuid>",
  "goal": "Upgrade framework and fix failing tests",
  "steps": [
    {
      "id": "s1",
      "action": "index_repo",
      "tool": "repo_indexer",
      "capability": "repo.read",
      "capabilityLabel": "Read repository",
      "timeoutSeconds": 300,
      "approvalRequired": false,
      "labels": ["repo", "automation"]
    },
    {
      "id": "s2",
      "action": "apply_changes",
      "tool": "code_writer",
      "capability": "repo.write",
      "capabilityLabel": "Apply repository changes",
      "timeoutSeconds": 900,
      "approvalRequired": true,
      "labels": ["repo", "automation", "approval"]
    },
    {
      "id": "s3",
      "action": "run_tests",
      "tool": "test_runner",
      "capability": "test.run",
      "capabilityLabel": "Execute tests",
      "timeoutSeconds": 900,
      "approvalRequired": false,
      "labels": ["repo", "automation"]
    },
    {
      "id": "s4",
      "action": "open_pr",
      "tool": "github_client",
      "capability": "github.write",
      "capabilityLabel": "Open pull request",
      "timeoutSeconds": 300,
      "approvalRequired": true,
      "labels": ["automation", "approval"]
    }
  ],
  "successCriteria": ["All tests pass","CI green","Docs updated"]
}


SSE event (AG‑UI‑style)

{
  "event":"plan.step",
  "trace_id":"<trace>",
  "plan_id":"<id>",
  "step":{"id":"s2","state":"waiting_approval","capability":"repo.write","summary":"Apply edits to 4 files"}
}

6) Security posture (operationalized) — STRIDE mapping
Threat	Primary risks	Controls (where)
S – Spoofing	Forged agent/service identity	OAuth 2.1 + PKCE for clients, OIDC for enterprise; mTLS between services; short‑lived JWTs with audience/tenant claims
T – Tampering	Prompt/plan or diff manipulation	Signed prompts for privileged flows; append‑only audit; signed commits/tags; OPA policy gates; read‑only FS; non‑root
R – Repudiation	“I didn’t run that tool/commit that change”	OTel traces (prompt/tool IO metadata); trace‑id ↔ commit‑id ↔ CI; Langfuse lineage
I – Information disclosure	RAG leaks; PII/secret exposure	Source ACL checks; DLP & secret scanning; DP on vectors (when required); per‑tenant encryption (CMEK)
D – DoS	Token floods, queue saturation	Rate limits; circuit breakers; queue‑based autoscaling; prompt caching; timeouts & step caps
E – Elevation of privilege	Over‑privileged tools/agents	Capability‑scoped tools; human approvals; OPA checks; egress allow‑lists; sandbox (container/WASM)

Secrets: never in code; stored in secrets backends; masked in logs; rotated; least scope.
Content capture: OFF by default; enable only for debugging in non‑prod with approvals.

7) Compliance & privacy

DPIA template and data inventory under docs/compliance/.

EU AI Act readiness: define intended use, datasets, risks, mitigations; system/model cards.

Data subject rights: document export & deletion procedures.

Data retention: logs/traces ≤ 30 days by default (configurable per tenant).

Regionalization (if needed): keep data in region; document endpoints & data flows.

8) GitHub standards & features

Branching: trunk‑based, short‑lived feature branches.

Commit messages: Conventional Commits (signed; DCO on).

CODEOWNERS: ownership for key paths (apps/, services/, charts/, docs/).

Templates: PULL_REQUEST_TEMPLATE.md and .github/ISSUE_TEMPLATE/* (feature/bug/security).

Labels & projects: type:*, priority:P0‑P3, deps, security, breaking, etc.

Release Drafter: auto‑draft release notes from PR titles & labels.

GHCR: images published as ghcr.io/<owner>/oss-ai-agent-tool/<service>.

Pages & OCI: Helm chart published to GitHub Pages AND oci://ghcr.io/<owner>/oss-ai-agent-tool/charts.

Renovate: automated dependency PRs (minor/patch auto‑merge; major grouped).

9) Documentation (Diátaxis) & UX

Tutorials (“Hello world”, “Upgrade a dependency safely”)

How‑to (“Add a provider with OAuth”, “Switch RabbitMQ→Kafka”, “Add a new MCP tool”)

Reference (APIs, event schemas, plan schema, CLI flags, Helm values)

Explanation (architecture, ADRs, tradeoffs, performance rationale)

Accessibility: keyboard navigation, ARIA labels, color contrast; basic screen reader flows.
Screenshots: sanitized, small diffs; include CLI samples and SSE traces where relevant.

10) CI/CD & supply chain (authoritative)

Workflows (names may already exist; otherwise agents must create them):

ci.yml: on PR & main — build & unit tests for Go/Node/Rust; docker build smoke.

security.yml: Trivy (FS/config + images), CodeQL (Go & JS/TS), Semgrep (SAST), gitleaks (secrets).

release-images.yml: on tags v* — build + push images to GHCR, cosign keyless sign, CycloneDX SBOM generation & attach to release.

release-charts.yml: on v*/chart-* — lint, package, publish to Pages + GHCR (OCI).

release-drafter.yml: auto‑draft release notes.

renovate.json: automated dependency updates.

Gates

PRs block on tests, code scanning (HIGH/CRITICAL, secrets), and policy checks.

Releases require passing evals (if applicable), signatures, SBOMs, and environment approvals (enterprise).

11) ALM: releases, incidents, ownership

Versioning: SemVer; tag vX.Y.Z.

Channels: alpha, beta, stable; use feature flags.

Release checklist: images built, signed, SBOMs attached; chart released; notes published; docs updated.

Incident mgmt: severity levels, on‑call rotations, runbooks, postmortems within 5 business days.

RACI: ensure each epic has accountable A and responsible R roles; list in issue/PR description.

12) Performance & cost engineering

Budgets (defaults): p95 TTFT ≤ 300 ms (LAN), p95 orchestrator RPC < 50 ms, cache hit rate ≥ 40% after 30 days.

Practices: prompt + retrieval caching; model routing to smallest model meeting eval thresholds; batching where safe; incremental indexing; queue‑based autoscaling (HPA on lag/depth).

Dashboards: latency, TTFT, token/cost, cache hit, queue depth, error rate, eval pass rate.

Load tests: periodic synthetic workloads; alert on SLO burn.

13) Consumer vs enterprise behaviors
Aspect	Consumer	Enterprise
Secrets	Local encrypted keystore	Vault or cloud secrets manager; rotation
Auth to providers	API keys; OAuth loopback where supported	OIDC/OAuth; service principals; SSO
Message bus	RabbitMQ default	Kafka backbone (RabbitMQ optional)
Deploy	Desktop + Docker Compose	Kubernetes + Helm; namespaces per env
Data	Local‑first; minimal retention	Retention policies, CMEK per tenant
Governance	Manual approvals more frequent	Policy‑driven approvals; audit automation
14) Agent profiles (agents/<name>/agent.md)

Agent files use YAML front‑matter + narrative guidance.

---
name: "code-writer"
role: "Code Writer"
capabilities: [repo.read, repo.write, test.run, plan.read]
approval_policy:
  repo.write: human_approval
  network.egress: deny
model:
  provider: auto          # openai | anthropic | google | azureopenai | bedrock | mistral | openrouter | local_ollama
  routing: default        # default | high_quality | low_cost
  temperature: 0.2
constraints:
  - "Write minimal, testable diffs with high coverage"
  - "Never bypass security gates"
---

# Guide
1) Read the plan, confirm scope.
2) Retrieve minimal context (symbolic + semantic + temporal).
3) Propose diffs + tests; request approval for writes.
4) Run tests in sandbox; collect artifacts.
5) Open PR with risks/rollback; link traces.

15) Coding standards & language‑specific best practices

TypeScript

strict mode; no any; zod schema validation for external IO; DI for side effects.

Structure: /src/providers/*, /src/plan/*, /src/agents/*, /src/auth/*, /src/queue/*.

Tests: unit (vitest/jest), integration (dockerized RabbitMQ/Kafka).

Go

Context timeouts; SSE flush semantics; avoid global state; structured logging; graceful shutdown (signals).

Rust

clippy + rustfmt; prefer async with cancellation; avoid unsafe; use tree‑sitter efficiently; test parsers with property tests.

Docs

Keep examples runnable; include CLI commands; validate links in CI.

16) Templates

PR checklist (short)

 Problem & approach described

 Tests added/updated; coverage acceptable

 Docs updated (Diátaxis section)

 Security impact (caps/egress/sandbox) assessed

 Performance impact (latency/cache) noted

 Rollback plan included

Issue (feature)

**Problem**
<what pain?>

**Proposal**
<how to solve?>

**Acceptance Criteria**
- [ ] measurable outcome 1
- [ ] measurable outcome 2

**Notes/Refs**
<links, ADRs>


Capability token (example)

{"tool":"repo","capabilities":["read","diff","apply(write:approved)"]}

17) Anti‑patterns (“don’t” list)

Don’t apply multi‑file changes without a plan + tests + PR.

Don’t include large, irrelevant context; minimize.

Don’t bypass sandbox, egress allow‑lists, or approvals “just this once.”

Don’t merge without updating user‑facing docs and release notes (if visible).

Don’t store secrets in code or logs.

Don’t skip tracing; every step must have a span.

18) Readiness checklists

Before merge

 Minimal relevant context retrieved; DLP & secret scan passed

 JSON plan approved for privileged steps

 OTel traces & SSE events emitted

 Tests executed and passing before advancing; if a valid bypass is required, document the rationale and obtain approval prior to proceeding

 Tests pass; artifacts captured

 PR includes risks/rollback; docs updated

 Security & compliance checks passed

 Performance budgets OK; cache impact measured

Before release

 Images built & cosign signed

 CycloneDX SBOMs attached to Release

 Helm chart packaged & published (Pages + OCI)

 Release notes drafted (Release Drafter) and finalized

 Canary deploy plan and rollback verified

19) Future work (out of scope for now)

Voice/WS collaboration, plugin marketplace, multi‑region active/active, fine‑tuning/training pipelines.

Advanced dynamic policy learning for approvals.

GPU scheduling & model‑side batching for local acceleration.

End of AGENTS.md
