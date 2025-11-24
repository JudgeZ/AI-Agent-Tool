# GUI timeline and approval flow

The desktop GUI (`apps/gui`) packages a SvelteKit frontend with a Tauri shell. It renders real-time plan execution coming from the orchestrator's Server-Sent Events (SSE) stream and provides the approval workflow required for privileged capabilities such as `repo.write` and `network.egress`.

## Prerequisites

* Node.js 18+
* Rust toolchain (for the Tauri host)
* `npm` or `pnpm`

### Linux packages (Tauri host)

Tauri's Linux bundle relies on several GTK/GNOME libraries in addition to the Rust toolchain. Install the packages before running `cargo test --workspace` or launching the shell:

```bash
sudo apt-get update
sudo apt-get install -y \
  pkg-config \
  libgtk-3-dev \
  libglib2.0-dev \
  libatk1.0-dev \
  libgdk-pixbuf-2.0-dev \
  libcairo2-dev \
  libpango1.0-dev \
  libsoup-3.0-dev \
  libwebkit2gtk-4.0-dev \
  libappindicator3-dev
```

These dependencies match the guidance in [`apps/gui/src-tauri/README.md`](../apps/gui/src-tauri/README.md). If you cannot install desktop libraries on your workstation, run `cargo test --workspace --exclude orchestrator-gui` to focus on the headless crates.

## Local development

```bash
cd apps/gui
npm install
npm run dev
```

By default the UI connects to `http://127.0.0.1:4000`. Override the orchestrator base URL when launching the dev server:

```bash
VITE_ORCHESTRATOR_URL=http://localhost:4010 npm run dev
```

> **Security defaults:** The bundled Tauri shell enforces a restrictive Content Security Policy (CSP) and capability guard. Only the local orchestrator endpoints (`http://127.0.0.1:4000`, `http://localhost:4000`, and `https://localhost:4000`) are permitted for API traffic. If you need to target a different host, update the CSP `connect-src` directive in `apps/gui/src-tauri/tauri.conf.json` and extend the capability manifest in `apps/gui/src-tauri/capabilities/main.json`.

The timeline page accepts a `plan` query parameter to start streaming immediately:

```
http://localhost:5173/?plan=plan-550e8400-e29b-41d4-a716-446655440000
```

### Tauri shell

Use the bundled commands to develop or package the desktop shell:

```bash
npm run tauri        # launches SvelteKit and embeds it in Tauri
npm run tauri:build  # produces distributable binaries
```

## IDE layout and controls

The shell opens with a three-pane layout and an optional terminal:

- **Left file explorer** – resizable between 220–520px.
- **Center editor** – Monaco-backed editor for the active session.
- **Right agent panel** – resizable between 320–640px for timeline and agent context.
- **Bottom terminal** – hidden by default, opens to ~240px high and can expand up to 520px.

Layout preferences persist in `localStorage` (`oss.ide.layout`) and are clamped to the supported bounds during hydration to avoid invalid dimensions. Reset by clearing that key and reloading.

### Resizing with mouse or touchpad

- Drag the vertical separators on either sidebar to change width. Primary-button drags only.
- Drag the horizontal handle above the terminal to change height; the panel must be open to resize.

### Keyboard accessibility

- **Sidebars:** focus the separator and use **←/→** arrows; increments are bounded by the same limits as mouse drags.
- **Terminal:** focus the handle and press **↑/↓** arrows to grow/shrink. Pressing an arrow while closed auto-opens the terminal before resizing.

ARIA labels and focus styling are enabled on all handles so screen readers can announce control purpose and current size.

### Terminal connection states

The IDE terminal connects to the orchestrator WebSocket at `/sandbox/terminal` using the authenticated session ID. Connection health is surfaced in the status bar with `connected`, `connecting`, `disconnected`, and `error` states. The client applies exponential backoff with up to six automatic retries for transient disconnects, halts retries when policy denials are returned, and exposes a **Reconnect** control when manual recovery is required. See [Sandbox terminal WebSocket](./sandbox-terminal.md) for the full message contract and backend safeguards.

## Collaborative project chat

The agent sidebar includes a real-time project chat backed by the same collaboration WebSocket used for co-editing. The client joins room IDs shaped like `chat:<tenantId>:<projectId>` and connects through `collaboration/ws` with the active session cookie. The panel automatically:

- Stays idle when the user is signed out and surfaces an error state (with a banner notification) when tenant/project context identifiers are invalid.
- Shows connection state and descriptive messaging (idle, connecting, connected, disconnected, error) and lets operators manually **Retry** when a disconnect occurs.
- Renders a signed-in identity badge derived from the session name or an obfuscated email fallback so addresses are never exposed to collaborators.
- Strips control characters from inbound and outbound text, enforces the 2,000-character message limit, and drops malformed payloads before caching or rendering.
- Maintains a bounded Yjs history (latest 500 stored, most recent 200 rendered) and scrolls to the newest messages automatically; caches are cleared on teardown before reconnecting.
- Disables sending unless both the collaboration socket and session are ready; the send button reflects the sanitized, trimmed draft value shown in the textarea.

Messages sync instantly across collaborators inside the same tenant/project once the connection reaches the `connected` state.

## SSE timeline

The frontend listens for `plan.step` events emitted by the orchestrator at `/plan/:planId/events`. Every event updates the timeline, appending the latest status transition and highlighting the associated capability badge. Connection state is surfaced at the top of the page so operators can quickly validate the stream health.

### Step states

The timeline displays all step states including:
- `queued` - Step is enqueued and waiting for execution
- `running` - Step is currently executing
- `waiting_approval` - Step requires human approval before execution
- `approved` - Step has been approved and will proceed
- `rejected` - Step was rejected by an operator
- `retrying` - Step failed and is being retried (shows attempt number)
- `completed` - Step finished successfully
- `failed` - Step failed after all retries
- `dead_lettered` - Step exhausted retry attempts and was moved to dead-letter queue

Each state transition includes a timestamp and optional summary. Retry attempts are tracked and displayed so operators can see how many times a step has been retried.

## Approval UX

When a step enters the `waiting_approval` state and advertises a privileged capability (for example `repo.write`), the UI raises a modal dialog that blocks interaction with the rest of the application. Operators must explicitly choose **Approve** or **Reject**. The modal submits the decision to the orchestrator endpoint `/plan/:planId/steps/:stepId/approve` and keeps the overlay until the orchestrator confirms the state transition through SSE. The approval history is preserved in the timeline so the audit trail is immediately visible.

## Smoke tests

Playwright smoke tests exercise the happy-path orchestration run. They spin up a mock SSE orchestrator (`npm run mock:orchestrator`), stream a plan, approve the guarded step, and assert that all status transitions render in the timeline. Run them with:

```bash
npm run test:e2e
```

The mock orchestrator and tests live under `apps/gui/tests/` and can be extended to cover additional scenarios (rejections, error states, etc.).
