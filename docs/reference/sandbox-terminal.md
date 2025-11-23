# Sandbox terminal WebSocket

The sandbox terminal bridges GUI users to a shared `node-pty` running inside the orchestrator process. Multiple clients attached to the same session share the same PTY output so collaborators can observe and interact with the same shell.

## Endpoint, authentication, and limits

- **Endpoint:** `wss://<gateway>/sandbox/terminal?sessionId=<session-id>` handled by the orchestrator gateway.
- **Authentication:** The gateway accepts either the session cookie (`config.auth.oidc.session.cookieName`) or a `Bearer` token in the `Authorization` header. The `sessionId` query parameter must match the authenticated session; mismatches are denied with `401`.
- **Origin allowlist:** When `server.cors.allowedOrigins` is populated, upgrade requests must supply an Origin header that matches the allowlist; missing or mismatched origins receive `403` responses.
- **Per-IP connection cap:** Connections are limited to `TERMINAL_CONNECTIONS_PER_IP` (default `20`). Exceeding the cap returns `429` with `Retry-After` guidance.
- **Payload limits:** The WebSocket layer enforces a 64KiB payload cap, and terminal messages larger than 16KiB are rejected and close the offending socket with policy code `1008`.

## Client → server messages

Clients must send UTF-8 JSON payloads under 16KiB that satisfy the schema below. Invalid, unsupported, or oversized messages close the connection with policy code `1008` and are logged for auditability.

```json
// Input keystrokes and paste events
{ "type": "input", "data": "string (<= 8192 chars)" }

// Resize notifications (batched client-side)
{ "type": "resize", "cols": 1-500, "rows": 1-200 }
```

## Server → client broadcasts

All server messages are JSON strings:

- `{ "type": "status", "status": "connected" | "disconnected", "clients": <count> }` – broadcast when clients attach or detach.
- `{ "type": "output", "data": "..." }` – PTY stdout/stderr stream.
- `{ "type": "exit", "exitCode": <code>, "signal"?: <signal> }` – emitted when the PTY exits; triggers session teardown.

Clients that cannot receive messages or return errors during delivery are closed with `1011` to prevent stalled sessions.

## Session lifecycle

- Each session id maps to a single PTY process with a shared client set.
- The PTY is terminated when it exits, when all clients disconnect, or when message delivery repeatedly fails.
- Closing the PTY broadcasts `exit` and closes any still-connected clients to avoid dangling sockets.

## Frontend behavior

The Svelte IDE terminal connects with the authenticated session id, applies exponential backoff for transient disconnects, and halts retries after six failed attempts or server-side policy denials. Users can manually reconnect from the status bar when retries stop.
