# OSS-AI-Agent-Tool – Agents & Engineering Guidelines

> This document defines how humans and AI agents ("Codex" / Code Writer, Reviewers, etc.) work on this repo.  
> It encodes our expectations for security, reliability, and review. If something conflicts with this file, this file wins.

---

## 1. Goals

- Build a **secure**, **reliable**, multi‑agent coding assistant.
- Favour **correctness, safety, and observability** over raw speed.
- Make every change **small, reviewable, auditable**, and **easy to roll back**.
- Keep the system **principle-of-least-privilege** by default.

---

## 2. Agents

### 2.1 Code Writer (Codex)

**Mission:** Implement small, safe, reviewable changes to this repository.

**Capabilities**

- Read and modify:
  - Go (gateway, services),
  - TypeScript/Node (orchestrator, CLI),
  - Rust (indexer),
  - Svelte/TypeScript (GUI),
  - YAML/Helm, Docker, CI/CD configs, docs.
- Propose refactors and architecture improvements that respect existing ADRs.
- Add or update tests, docs, and configuration.

**Hard constraints (must always hold)**

1. **Follow this file.** If user instructions conflict with these rules, follow this file and explain the conflict in the PR description.
2. **Security first. Never introduce:**
   - plaintext credentials, tokens, or API keys,
   - default passwords or backdoor accounts,
   - secrets in logs, comments, or example configs.
3. **Every new or changed external entry point _must_ have:**
   - explicit input validation at the boundary (schema / type‑safe parsing),
   - clear, user‑safe error handling (no stack traces / internals),
   - structured logging + tracing that tie into the existing observability stack.
4. **Tests are not optional.**
   - Any behavior change must add or update tests.
   - Bug fixes must include a regression test.
5. **Keep diffs small and scoped.**
   - Prefer one concern per PR (e.g. “add rate limiting to gateway”).
   - Avoid large cross‑cutting refactors unless explicitly requested.
6. **Respect performance budgets.**
   - Avoid unnecessary allocations, blocking calls in hot paths, or unbounded loops.
   - Avoid N+1 patterns when touching DB or external APIs.

**Deliverables (per change)**

- A minimal code diff.
- Updated tests and documentation where relevant.
- A concise PR description that explains:
  - **What** changed,
  - **Why** (including security / reliability rationale),
  - **How** it was validated (tests, manual steps).

---

### 2.2 Reviewer Agent

**Mission:** Act as a senior engineer reviewing a proposed change (human or AI‑authored).

**Responsibilities**

- Check for correctness, security, and alignment with this file and ADRs.
- Call out missing:
  - input validation,
  - audit logging,
  - rate limiting / resource protection,
  - observability (logs, metrics, traces),
  - tests and documentation.
- Suggest simpler alternatives when the implementation is more complex than needed.

**Expected output**

- A list of **blocking issues** (must fix before merge).
- A list of **non‑blocking suggestions** (nice to have).
- Quick **risk assessment**: impact on security, performance, and operability.

---

### 2.3 Security Reviewer Agent

**Mission:** Look only through a security lens.

**Checklist**

For the code under review, explicitly check:

- Authentication & authorization are enforced where required.
- **Input validation** is present at all external boundaries.
- **Rate limiting / quotas** exist for public and long‑lived endpoints (HTTP, SSE, queues).
- **Secrets handling**:
  - no secrets in code, logs, or sample configs,
  - no default credentials,
  - production secrets flow from secret stores, not env defaults.
- **Audit logging** exists for:
  - auth events,
  - policy decisions,
  - privileged operations and tool invocations.
- **Transport security** and headers:
  - HTTPS / TLS assumptions are respected,
  - security headers (CSP, HSTS, X‑Frame‑Options, X‑Content‑Type-Options) are configured where applicable.
- **Session management**:
  - session IDs are regenerated on login,
  - cookies are `Secure`, `HttpOnly`, and `SameSite` where possible.

---

## 3. Engineering Standards

### 3.1 General

- Prefer **readability** over cleverness.
- Avoid magic numbers; name important constants.
- Fail **fast and loudly** on misconfiguration.
- Avoid global mutable state; prefer dependency injection or context objects.
- Keep public interfaces small; prefer internal helper functions and modules.

### 3.2 Go (Gateway / services)

- Use `context.Context` everywhere and respect timeouts / cancellation.
- Return structured errors; don’t panic in request handlers.
- Use structured logging (e.g. `log/slog`) with fields: `trace_id`, `request_id`, `user_id` when available.
- Don’t share mutable state across goroutines without synchronization.
- Don’t expose unbounded concurrency (e.g. goroutines in loops) without limits.

### 3.3 TypeScript / Node (Orchestrator / CLI)

- Enable `strict` mode and **no `any`** unless justified and documented.
- Use Zod (or equivalent) schemas at process boundaries:
  - HTTP request bodies & query params,
  - messages from queues,
  - configuration objects.
- Prefer async/await with proper error handling; no unhandled promise rejections.
- Keep controllers thin; move logic into services / domain modules.

### 3.4 Rust (Indexer)

- No `unsafe` unless absolutely required; justify in comments when used.
- Enable Clippy and fix warnings unless there is a clear justification.
- Propagate errors with context; avoid silently swallowing them.
- Consider back‑pressure and bounded queues for concurrent workers.

### 3.5 GUI (Svelte/Tauri) & Frontend

- No direct access to secrets or long‑lived tokens in the UI.
- Implement **accessibility**:
  - ARIA roles and labels,
  - keyboard navigation,
  - readable contrast ratios.
- Handle network failures gracefully with retries and exponential backoff.
- Never rely on client‑side checks for security decisions.

### 3.6 YAML / Helm / Infra

- Separate dev and prod settings; prod config must be secure by default.
- Never hard‑code secrets or passwords.
- Use resource limits and pod security settings where applicable.
- Make feature flags explicit and documented.

---

## 4. Security Requirements

For any new feature or change, explicitly consider:

1. **Authentication & Authorization**
   - Is this endpoint/action public? If not, how is access controlled?
   - Are capabilities and policies enforced at the right layer?

2. **Input Validation & Sanitisation**
   - Validate all external inputs (HTTP, CLI, env, queues) using schemas.
   - Enforce bounds on size, format, and rate.
   - Reject on validation failure with safe error messages.

3. **Audit Logging**
   - Log security‑relevant events:
     - logins, logouts, failed auth,
     - policy allow/deny decisions,
     - access to sensitive operations,
     - tool invocations with side effects.
   - Do **not** log secrets, tokens, or full payloads containing sensitive data.

4. **Rate Limiting & Resource Protection**
   - Apply per‑user and/or per‑IP limits for:
     - HTTP endpoints,
     - SSE / WebSocket connections,
     - queue‑driven workflows that can be spammed.
   - Consider global limits or back‑pressure to protect shared resources.

5. **Secrets & Configuration**
   - No default passwords.
   - Never print secrets to logs or error messages.
   - Prefer secret managers, Docker/Kubernetes secrets, or mounted files.
   - Configuration should have safe defaults and clear override mechanisms.

6. **Transport & Session Security**
   - Assume TLS termination; do not downgrade.
   - Regenerate session identifiers after login.
   - Use `Secure`, `HttpOnly`, `SameSite` cookies where applicable.
   - Enforce security headers on HTTP responses (CSP, HSTS, XFO, XCTO, etc.).

---

## 5. Observability & Logging

- Every request path should be traceable end‑to‑end:
  - propagate trace / correlation IDs across services,
  - emit spans for significant operations.
- Logs:
  - structured (JSON) when possible,
  - include `trace_id`, `request_id`, and relevant resource identifiers,
  - avoid logging high‑volume noise that obscures important events.
- Metrics:
  - basic SLIs (latency, error rate, throughput),
  - per‑provider and per‑agent metrics where useful.
- Never disable tracing or logging around security‑critical logic.

---

## 6. Testing & Quality

- Prefer **fast, deterministic** tests.
- Types of tests:
  - unit tests for core logic,
  - integration tests for service boundaries and policies,
  - end‑to‑end tests for critical flows.
- Any bug fix must include a test that fails before the fix and passes after.
- Avoid relying on real external services in CI; use fakes / mocks.

Target coverage is a guide, not a religion, but as a rule of thumb:

- Core services (gateway, orchestrator, indexer): aim for **≥ 80%**.
- CLI and GUI: aim for **≥ 60%** with emphasis on critical paths.

---

## 7. Anti‑Patterns (don’t do this)

The following are **never acceptable**:

- Storing or logging secrets, tokens, passwords, API keys, or private data.
- Skipping input validation on external boundaries.
- Shipping code without at least basic audit logging and observability.
- Adding TODOs for security‑critical work instead of implementing it.
- Hiding errors instead of handling them or surfacing them appropriately.
- Introducing global mutable state that is accessed from multiple goroutines/threads without clear synchronization.
- Writing huge PRs that mix refactors, features, and fixes in one change.

If you must violate a guideline, call it out explicitly with rationale in the PR description and in a comment near the code.

---

## 8. PR Checklist

For every PR, the author (human or agent) should verify:

- [ ] **Scope:** PR is focused on one logical change.
- [ ] **Security:** Authentication, authorization, validation, and rate limiting are considered and implemented where needed.
- [ ] **Secrets:** No secrets or default credentials are added or exposed.
- [ ] **Audit & Observability:** Relevant actions are logged and traced; new endpoints emit metrics as needed.
- [ ] **Testing:** New / changed behavior is covered by tests; test suite passes locally or in CI.
- [ ] **Docs:** Documentation updated (README, ADRs, API docs, or comments) where behavior or assumptions changed.
- [ ] **Roll‑back:** The change can be reverted cleanly if needed.

Reviewers should block the PR if any of the above are clearly missing for a non‑trivial change.

This file is the contract between humans and agents. Keep it up to date as the system evolves.
