# GUI timeline and approval flow

The desktop GUI (`apps/gui`) packages a SvelteKit frontend with a Tauri shell. It renders real-time plan execution coming from the orchestrator's Server-Sent Events (SSE) stream and provides the approval workflow required for privileged capabilities such as `repo.write` and `network.egress`.

## Prerequisites

* Node.js 18+
* Rust toolchain (for the Tauri host)
* `npm` or `pnpm`

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

> **Security defaults:** The bundled Tauri shell enforces a restrictive Content Security Policy (CSP) and HTTP allowlist. Only the local orchestrator endpoints (`http://127.0.0.1:4000`, `http://localhost:4000`, and `https://localhost:4000`) are permitted for API traffic. If you need to target a different host, update `apps/gui/src-tauri/tauri.conf.json` to add the destination to both the CSP `connect-src` directive and the `allowlist.http.scope` array.

The timeline page accepts a `plan` query parameter to start streaming immediately:

```
http://localhost:5173/?plan=plan-1234
```

### Tauri shell

Use the bundled commands to develop or package the desktop shell:

```bash
npm run tauri        # launches SvelteKit and embeds it in Tauri
npm run tauri:build  # produces distributable binaries
```

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
