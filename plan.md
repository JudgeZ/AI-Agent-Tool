# AI-Agent-Tool – Collaboration & Platform Expansion Plan

This document defines a phased implementation plan to:

- Add real-time collaborative coding (Yjs + WebSockets).
- Harden file access with locking + HITL review.
- Turn the GUI into a full IDE (triad layout, shared terminal, chat).
- Introduce Cases & Workflows as a platform layer.
- Add CLI and browser extension integrations.

Each task is sized so a developer or code assistant (e.g. Codex) can implement it in one or a few sessions.

---

## General Principles

- **Gateway-first:** All client traffic (HTTP, SSE, WebSocket, CLI, browser extension) terminates at the Gateway and is authenticated there. Orchestrator is *never* directly exposed.
- **Single source of truth:** Orchestrator owns plans, workflows, cases, collab docs, locks.
- **CRDT-first editing:** Open files are synchronized via Yjs; disk is persistence / cold storage.
- **Scoped resources:** Collab docs, locks, containers, and terminals are scoped by tenant + project + case/session.
- **Secure by default:** No network from containers unless explicitly allowed; file access is constrained to project roots; browser telemetry is opt-in and high-level only.

---

## How to Use This Plan (with Codex or manually)

For each task:

1. Open the referenced file(s) in your editor.
2. Read the task description & acceptance criteria.
3. Ask your coding assistant to implement the task in the given file(s), or do it manually.
4. Run tests / basic manual checks.
5. Check the task off `[x]` when it’s done.

---

## Phase 1 – Core Collaboration (Foundation)

Goal: Real-time coding + safe agent writes, without a big UX overhaul yet.

### 1.1 Gateway WebSocket proxy for collaboration

- [ ] **Task:** Add a WebSocket reverse proxy for collaboration traffic.
- **Files:**
  - `apps/gateway-api/internal/gateway/collaboration.go` (new)
  - `apps/gateway-api/main.go` (or router entrypoint)
- **Details:**
  - Implement `RegisterCollaborationRoutes(mux *http.ServeMux)`:
    - Register `"/collaboration/ws"` on the Gateway.
    - Use `httputil.NewSingleHostReverseProxy` to proxy to Orchestrator `/collaboration/ws`.
    - In the proxy `Director`, set `req.URL.Scheme` and `req.URL.Host` from existing orchestrator config.
    - Preserve all WebSocket-related headers (`Connection`, `Upgrade`, `Sec-WebSocket-*`) including `Sec-WebSocket-Protocol`.
  - Enforce auth **before** proxying:
    - For browser/GUI: validate session cookie/JWT via existing middleware.
    - For CLI/extension: validate `Authorization: Bearer <token>` using existing auth helpers.
    - If auth fails, return 401/403 and do not proxy.
  - Wire `RegisterCollaborationRoutes` from `main.go`.

**Acceptance criteria:**

- Unauthenticated WS upgrade to `/collaboration/ws` fails.
- Authenticated WS upgrade reaches Orchestrator and Upgrade works.
- No direct Orchestrator WS port is exposed externally.

---

### 1.2 Orchestrator collaboration server (Yjs + y-websocket)

- [ ] **Task:** Add a Yjs-based collab server in Orchestrator.
- **Files:**
  - `services/orchestrator/package.json`
  - `services/orchestrator/src/collaboration/index.ts` (new)
  - `services/orchestrator/src/index.ts`
- **Details:**
  - Add deps: `ws`, `y-websocket`, `yjs`, `@types/ws`.
  - Implement `setupCollaborationServer(httpServer: http.Server)`:
    - `WebSocketServer` attached to `httpServer`, path `/collaboration/ws`.
    - Use `y-websocket` utilities (`setupWSConnection`) with a map of `roomId -> Y.Doc`.
  - Room scoping:
    - Extract identity/workspace from headers set by Gateway (e.g. `X-Tenant-Id`, `X-Project-Id`, `X-Session-Id`).
    - Parse `filePath` from query params.
    - Compute `roomId = hash(tenantId + ":" + projectId + ":" + filePath)`.
  - AuthZ:
    - If identity headers are missing, close with 4401/4403.
    - If user is not allowed to see that project/file (use existing ACL helpers where possible), close.
  - Integrate:
    - In `src/index.ts`, after creating HTTP server, call `setupCollaborationServer(server)`.

**Acceptance criteria:**

- Multiple WS clients can join the same room and see Yjs sync.
- Unauthorized or malformed connections are rejected.
- Collab server runs in the same process as the Orchestrator HTTP API.

---

### 1.3 Yjs history compaction & “busy” tracking

- [ ] **Task:** Track recent user edits and compact Yjs history.
- **Files:**
  - `services/orchestrator/src/collaboration/index.ts`
- **Details:**
  - Maintain an in-memory map:
    - `roomId -> { ydoc: Y.Doc, lastUserEditAt: number }`.
  - Update `lastUserEditAt` whenever a content update from a **human** client is applied (Y.Text changes, not agent changes).
  - Export helper:
    - `isRoomBusy(roomId: string, thresholdMs = 5000): boolean`
  - Compaction:
    - Add a periodic task (e.g. `setInterval`) that:
      - For inactive rooms (no clients and last activity older than N minutes):
        - Writes the current `Y.Text` to disk (use existing FS service).
        - Drops the old `Y.Doc` and recreates a fresh one seeded from file contents, thus discarding Yjs history.
  - Agent edits:
    - Export `applyAgentEditToRoom(roomId: string, newContent: string)` that updates the `Y.Text` inside a Yjs transaction without bumping `lastUserEditAt`.

**Acceptance criteria:**

- `isRoomBusy` reflects recent human edits.
- Compaction does not break connected clients or lose current content.
- Agents can apply edits via Yjs rather than directly writing files.

---

### 1.4 FileLockManager & Redis-backed lock history

- [ ] **Task:** Implement a `FileLockManager` around the existing `DistributedLockService`.
- **Files:**
  - `services/orchestrator/src/services/DistributedLockService.ts`
  - `services/orchestrator/src/services/FileLockManager.ts` (new)
  - `services/orchestrator/src/queue/PlanQueueRuntime.ts`
- **Details:**
  - Ensure `DistributedLockService` is accessible as a singleton.
  - Implement `FileLockManager`:
    - Lock key: `lock:file:<normalizedPath>`.
    - Methods:
      - `acquireLock(sessionId, path, agentId)`:
        - Check Yjs `isRoomBusy` for that file (if integrated).
        - If busy, return a specific error.
        - Otherwise, attempt to acquire the distributed lock.
        - Record lock in `SessionLockHistory` (in-memory + Redis key `session:locks:<sessionId>`).
      - `releaseSessionLocks(sessionId)`:
        - Release all current locks.
        - Keep history for audit.
      - `restoreSessionLocks(sessionId)`:
        - Load history from Redis and best-effort re-acquire locks.
  - Plan lifecycle:
    - On plan start/resume: `restoreSessionLocks`.
    - On plan complete/fail: `releaseSessionLocks`.

**Acceptance criteria:**

- Locks prevent concurrent agent writes to the same file.
- Session restarts restore locks where possible and log failures.
- `FileLockManager` can be used from tools without circular imports.

---

### 1.5 FileSystemTool: projectRoot scoping, locking, HITL

- [ ] **Task:** Harden FileSystem tool with scoping, locking, and optional human review.
- **Files:**
  - `services/orchestrator/src/tools/core/FileSystemTool.ts` (path may vary)
- **Details:**
  - Project root scoping:
    - Resolve any requested `path` against `projectRoot`.
    - If resolved path escapes `projectRoot` (`..`), reject with a clear error.
  - Integrate `FileLockManager`:
    - For `write/replace/delete`:
      - `acquireLock(sessionId, normalizedPath, agentId)` before changes.
      - If cannot lock (busy / held by another session), fail with structured error.
  - HITL review:
    - If `requiresReview` flag is set or path matches critical patterns:
      - Generate a diff or description of changes.
      - Emit an approval request via existing HITL/approval mechanism.
      - Apply changes only after approval.
      - On denial or timeout, do not write and release lock.
  - Agent/Yjs integration:
    - Instead of editing files directly, call `applyAgentEditToRoom` so Yjs doc is source of truth; let collab server flush to disk.

**Acceptance criteria:**

- No file operations can escape `projectRoot`.
- Agent writes are serialized through locks.
- Critical writes require approval and are visible in the UI.

---

### 1.6 File explorer sync (orchestrator → GUI)

- [ ] **Task:** Sync file explorer via disk watcher & events.
- **Files:**
  - `services/orchestrator/src/fs/FileWatcherService.ts` (new or existing)
  - Gateway route for SSE/WS events
  - GUI explorer store/component
- **Details (backend):**
  - Use `chokidar` (or similar) to watch each project workspace root.
  - Emit events: `{ type, path, oldPath?, projectId }` on create/delete/rename/change.
  - Expose events via SSE (`/events/fs`) or a lightweight WS channel through Gateway.
- **Details (frontend):**
  - Subscribe to `/events/fs` (or equivalent).
  - Incrementally update the file tree (add/remove/rename nodes).
  - Fallback to full reload on desync.

**Acceptance criteria:**

- Creating/renaming/deleting a file is reflected in all connected explorers in near-real-time.

---

### 1.7 GUI: collaborate-aware IDE store

- [ ] **Task:** Add collaboration state and roomId derivation.
- **Files:**
  - `apps/gui/src/lib/stores/ide.ts`
- **Details:**
  - Add:
    - `collaborationStatus: 'disconnected' | 'connecting' | 'connected' | 'error'`.
    - `currentRoomId: string | null`.
  - Derive `currentRoomId` from `(tenantId, projectId, filePath)` using the same scheme as the backend.
  - Expose setters for status so `Editor.svelte` can update on WS events.

**Acceptance criteria:**

- IDE store always knows the current roomId for an open file.
- Status changes reflect connection lifecycle.

---

### 1.8 GUI: Editor.svelte + Yjs + y-monaco

- [ ] **Task:** Make the editor collaborative.
- **Files:**
  - `apps/gui/package.json`
  - `apps/gui/src/lib/components/ide/Editor.svelte`
- **Details:**
  - Ensure deps: `yjs`, `y-websocket`, `y-monaco`.
  - In `Editor.svelte`:
    - On mount/file change:
      - Create `Y.Doc` + `Y.Text`.
      - Create a `WebsocketProvider` pointing at `wss://<gateway>/collaboration/ws` with appropriate room identifier.
      - Bind Monaco model to `Y.Text` using `MonacoBinding`.
      - Configure awareness to share user name/color from session store.
    - On destroy/file close:
      - Dispose provider/binding/doc.
    - Update `collaborationStatus` based on provider events.
  - Keep local editing functional if WS fails (fallback behavior).

**Acceptance criteria:**

- Two browser tabs editing the same file see each other’s edits and cursors in real-time.
- Editor remains usable offline / when WS fails.

---

## Phase 2 – IDE Experience (The Editor)

Goal: Flesh out the IDE UX around the collaboration foundation.

### 2.1 Triad layout

- [ ] **Task:** Implement a three-pane + terminal layout.
- **Files:**
  - `apps/gui/src/routes/+layout.svelte`
  - Possibly small layout components under `src/lib/components/layout/*`
- **Details:**
  - Layout:
    - Left: file explorer.
    - Center: editor.
    - Right: agent panel (chat + plan timeline).
    - Bottom: shared terminal (toggleable).
  - Ensure existing routing/session behavior remains unchanged.
  - Allow panels to be resized or toggled if feasible; otherwise fixed ratios.

**Acceptance criteria:**

- IDE shows explorer, editor, agent panel, and terminal in a predictable layout.
- No regressions in navigation.

---

### 2.2 Shared terminal (GUI + Orchestrator)

- [ ] **Task:** Add a shared terminal per session/case.
- **Backend Files:**
  - `services/orchestrator/src/sandbox/TerminalManager.ts` (new)
  - WS wiring in `src/collaboration/index.ts` or separate module (path `/sandbox/terminal`)
- **Frontend Files:**
  - `apps/gui/package.json` (`xterm`, `xterm-addon-fit`)
  - `apps/gui/src/lib/components/ide/Terminal.svelte`
- **Details (backend):**
  - For each session/case, maintain a single pty (using `node-pty`) inside the session’s container.
  - WS endpoint `/sandbox/terminal` attaches/detaches clients to that pty.
  - Only authenticated session members can attach.
- **Details (frontend):**
  - `Terminal.svelte`:
    - Instantiate `xterm.Terminal`.
    - Connect to `wss://<gateway>/sandbox/terminal?sessionId=...`.
    - Relay keyboard input to WS; print WS data to terminal.
    - Present connection status; handle cleanup on destroy.

**Acceptance criteria:**

- Multiple clients connected to the same session see identical terminal output.
- Terminal commands run in the same environment as the agent.

---

### 2.3 Project-scoped team chat

- [ ] **Task:** Simple Yjs-based team chat in IDE.
- **Files:**
  - `apps/gui/src/lib/components/ide/Chat.svelte`
  - Uses existing collab WS endpoint with a project-level room
- **Details:**
  - Chat doc:
    - Room id like `chat:<tenantId>:<projectId>`.
    - `Y.Array` of `{ id, userId, userName, text, timestamp }`.
  - UI:
    - Scrollable list of messages.
    - Input + send.
  - Integrate with existing session store for identity.
  - Place in the right panel (possibly alongside or under agent panel).

**Acceptance criteria:**

- Two users on the same project see each other’s chat messages live.

---

### 2.4 Web deployment & Remote FS

- [ ] **Task:** Enable browser-only mode & remote FS fallback.
- **Files:**
  - `apps/gui/svelte.config.js`
  - Any Tauri integration points
  - New FS abstraction: `apps/gui/src/lib/services/fs.ts`
- **Details:**
  - SvelteKit:
    - Use `adapter-node` or `adapter-static` for web builds.
  - FS abstraction:
    - Provide Tauri-based implementation when running in desktop.
    - Provide HTTP-based implementation calling Orchestrator Remote FS API when in web mode.
  - Refactor components to use FS abstraction instead of direct Tauri APIs.

**Acceptance criteria:**

- IDE can run purely in the browser and still open/save files via Orchestrator.
- Desktop (Tauri) mode still works.

---

## Phase 3 – Automation & Operations (The Platform)

Goal: Unify plans into workflows and add Case/Operations views.

### 3.1 CaseService & schema

- [ ] **Task:** Introduce Cases, Tasks, and Artifacts in Orchestrator.
- **Files:**
  - DB migrations
  - `services/orchestrator/src/cases/CaseService.ts`
  - Case HTTP/gRPC endpoints
- **Details:**
  - DB tables: `cases`, `tasks`, `artifacts` (with tenant/project IDs, status, metadata).
  - `CaseService`:
    - CRUD for cases & tasks.
    - `attachArtifact(caseId, type, ref, metadata)`.
  - Map active sessions to Cases (e.g. `getOrCreateCaseForSession`).

**Acceptance criteria:**

- Cases can be created/listed via API.
- Workflows/plans can be associated with a Case.

---

### 3.2 WorkflowEngine (unify plans & workflows)

- [ ] **Task:** Refactor plan execution to a generic WorkflowEngine.
- **Files:**
  - `services/orchestrator/src/plan/planner.ts` (existing)
  - `services/orchestrator/src/workflow/WorkflowEngine.ts` (new)
  - `services/orchestrator/src/queue/PlanQueueRuntime.ts`
- **Details:**
  - Define generic `Workflow` and `WorkflowNode` with node types:
    - `AgentStep`, `CodeStep`, `ApprovalStep`, `TriggerStep`.
  - Implement execution of linear workflows (for current plans).
  - Keep the current plan APIs but map them to workflows internally.
  - Replace PlanQueueRuntime with WorkflowRuntime while preserving queue semantics.

**Acceptance criteria:**

- Existing plan flows still work.
- Workflows can be stored in DB and re-run or inspected.

---

### 3.3 Ops UI (Cases & Workflows)

- [ ] **Task:** Add an Ops mode in GUI with Cases & Workflows views.
- **Files:**
  - `apps/gui/src/routes/+layout.svelte` (mode switch)
  - `apps/gui/src/routes/ops/cases/+page.svelte`
  - `apps/gui/src/routes/ops/workflows/+page.svelte`
- **Details:**
  - Layout:
    - Mode switch between **IDE** and **Ops**.
  - `/ops/cases`:
    - Show cases (table or Kanban by status).
    - Link to case details.
  - `/ops/workflows`:
    - List workflows.
    - Show basic detail view (graph can be a later enhancement).

**Acceptance criteria:**

- Ops mode is usable for browsing cases & workflows.
- IDE mode unaffected.

---

## Phase 4 – Ecosystem (The Tools)

Goal: Extend platform to CLI and browser.

### 4.1 CLI – Gateway-connected, Aider-style

- [ ] **Task:** Improve CLI to talk to Gateway and orchestrator.
- **Files:**
  - `apps/cli/src/index.ts`
  - Config/docs
- **Details:**
  - Read `GATEWAY_URL` and `API_KEY` from config/env.
  - Implement commands:
    - `/chat` – interactive chat mapped to orchestrator agent endpoint.
    - `/code` – code-change workflow.
    - `/commit` – git integration (auto-commit with AI message).
    - `/ops` – list cases/workflows.
  - All calls use `Authorization: Bearer <API_KEY>` to Gateway.

**Acceptance criteria:**

- CLI can run basic chat and code flows via Gateway.
- API key auth is enforced.

---

### 4.2 Browser extension – telemetry & automation

- [ ] **Task:** Add Chrome extension for browser telemetry.
- **Files:**
  - `apps/browser-extension/manifest.json`
  - `apps/browser-extension/src/background.ts`
  - (optional) content scripts
- **Details:**
  - Manifest V3:
    - `tabs`, `activeTab`, `scripting` permissions.
    - `host_permissions` for Gateway, not Orchestrator.
  - Background:
    - Connect to `wss://<gateway>/telemetry` with API key.
    - Receive `Record` / `Stop` / `Replay` commands.
    - When recording, capture high-level actions (clicks/inputs) from content script and send to Gateway.
    - Never record password fields; recording must be explicit and visibly indicated.

**Acceptance criteria:**

- Extension can connect to Gateway and send simple click/input events.
- Recording is opt-in and limited to configured hosts.

---

## Phase 5 – Hardening & Scaling (Ongoing)

These tasks are ongoing and can be scheduled as needed:

- [ ] Multi-tenant enforcement across collab rooms, cases, workflows, containers.
- [ ] More advanced Yjs persistence (DB snapshots, time-travel).
- [ ] Advanced workflow triggers (GitHubApp, SecurityApp, event bus).
- [ ] Sandbox policies: per-workflow network allowlists; resource limits.
- [ ] Metrics & tracing for collab sessions, workflows, containers, telemetry volume.

---
