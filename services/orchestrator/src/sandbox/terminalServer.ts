import http from "node:http";
import type https from "node:https";
import type { IncomingMessage } from "node:http";

import ipaddr from "ipaddr.js";
import { WebSocketServer } from "ws";
import { z } from "zod";

import { sessionStore, type SessionRecord } from "../auth/SessionStore.js";
import { validateSessionId, type SessionExtractionResult, type SessionSource } from "../auth/sessionValidation.js";
import type { AppConfig } from "../config.js";
import { logAuditEvent } from "../observability/audit.js";
import { hashIdentifier } from "../observability/audit.js";
import { appLogger, normalizeError } from "../observability/logger.js";
import { SessionIdSchema } from "../http/validation.js";
import { TerminalManager } from "./TerminalManager.js";
import { markUpgradeHandled } from "../server/upgradeMarkers.js";
const TERMINAL_WS_PATH = "/sandbox/terminal";
const MAX_TERMINAL_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_CONNECTIONS_PER_IP = 20;

const terminalParamsSchema = z.object({
  sessionId: SessionIdSchema,
});

type IpAddress = ipaddr.IPv4 | ipaddr.IPv6;

const ipConnectionCounts = new Map<string, number>();

/**
 * Extracts the first non-empty trimmed header string from a header value that may be a string, an array of strings, or undefined.
 *
 * @param value - Header value as a string, an array of strings, or undefined
 * @returns The first non-empty trimmed string if present, otherwise `undefined`
 */
function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.find((entry) => typeof entry === "string" && entry.trim().length > 0)?.trim();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

/**
 * Clean a header string for safe logging by removing carriage returns and line feeds and limiting length to 512 characters.
 *
 * @param value - The header value to sanitize; may be `undefined`.
 * @returns The sanitized header string, or `undefined` if the input was falsy.
 */
function sanitizeHeaderForLog(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/\r|\n/g, "").slice(0, 512);
}

/**
 * Parses a raw IP string into an ipaddr.js IP object, normalizing IPv6 zone identifiers
 * and converting IPv4-mapped IPv6 addresses to IPv4.
 *
 * @param raw - The raw IP address string (may include an IPv6 zone identifier)
 * @returns The parsed `IpAddress` object, or `undefined` if `raw` is missing or invalid
 */
function parseIpAddress(raw: string | undefined): IpAddress | undefined {
  if (!raw) {
    return undefined;
  }
  const sanitized = raw.includes("%") ? raw.split("%", 1)[0] : raw;
  try {
    const parsed = ipaddr.parse(sanitized.trim());
    if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
      return (parsed as ipaddr.IPv6).toIPv4Address();
    }
    return parsed as IpAddress;
  } catch {
    return undefined;
  }
}

/**
 * Determines whether an IP address falls within any of the provided trusted proxy CIDR ranges.
 *
 * @param address - The IP address to check.
 * @param trustedProxyCidrs - Array of CIDR strings representing trusted proxy networks; invalid or empty entries are ignored.
 * @returns `true` if `address` is contained in at least one CIDR from `trustedProxyCidrs`, `false` otherwise.
 */
function isTrustedProxyIp(address: IpAddress, trustedProxyCidrs: readonly string[]): boolean {
  if (trustedProxyCidrs.length === 0) {
    return false;
  }
  for (const entry of trustedProxyCidrs) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const [network, prefixLength] = ipaddr.parseCIDR(trimmed);
      if (network.kind() !== address.kind()) {
        continue;
      }
      if (address.match([network, prefixLength])) {
        return true;
      }
    } catch {
      // ignore invalid trusted proxy entries
    }
  }
  return false;
}

/**
 * Determines whether an IP address is loopback, link-local, or private/unique-local.
 *
 * @param address - The parsed IP address to evaluate
 * @returns `true` if the address is loopback, link-local, or private (for IPv4) / unique local (for IPv6), `false` otherwise
 */
function isPrivateOrLoopback(address: IpAddress): boolean {
  if (address.kind() === "ipv4") {
    const range = (address as ipaddr.IPv4).range();
    return range === "loopback" || range === "linkLocal" || range === "private";
  }
  const range = (address as ipaddr.IPv6).range();
  return range === "loopback" || range === "linkLocal" || range === "uniqueLocal";
}

/**
 * Determine the originating client IP address for an HTTP upgrade request, honoring trusted proxy CIDRs and X-Forwarded-For headers.
 *
 * @param req - The incoming HTTP(S) request whose socket and headers are inspected
 * @param trustedProxyCidrs - Array of CIDR strings identifying trusted proxy addresses to be skipped when resolving the client IP
 * @returns The resolved client IP as a string; returns `"unknown"` if the remote address cannot be parsed. If the remote address is a trusted proxy or private/loopback, the last non-proxy IP from `X-Forwarded-For` is returned when available, otherwise the remote address string is returned.
 */
function resolveClientIp(req: IncomingMessage, trustedProxyCidrs: readonly string[]): string {
  const remote = parseIpAddress(req.socket.remoteAddress ?? undefined);
  if (!remote) {
    return "unknown";
  }

  if (!isTrustedProxyIp(remote, trustedProxyCidrs) && !isPrivateOrLoopback(remote)) {
    return remote.toString();
  }

  const forwarded = headerValue(req.headers["x-forwarded-for"]);
  if (forwarded) {
    const entries = forwarded
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const candidate = parseIpAddress(entries[i]);
      if (candidate && !isTrustedProxyIp(candidate, trustedProxyCidrs)) {
        return candidate.toString();
      }
    }
  }

  return remote.toString();
}

/**
 * Extracts request and trace identifiers from incoming HTTP headers.
 *
 * @returns An object with optional `requestId` and `traceId` string values read from `X-Request-Id` and `X-Trace-Id` headers, respectively; each property is `undefined` if the corresponding header is missing or empty.
 */
function requestIdentifiers(req: IncomingMessage): { requestId?: string; traceId?: string } {
  return {
    requestId: headerValue(req.headers["x-request-id"]),
    traceId: headerValue(req.headers["x-trace-id"]),
  };
}

/**
 * Selects an application logger augmented with a trace identifier when present.
 *
 * Reads the `X-Trace-Id` header (falling back to `X-Request-Id`) from the request and, if found,
 * returns a child logger that includes `trace_id`; otherwise returns the default application logger.
 *
 * @param req - HTTP upgrade or request object whose headers may contain trace identifiers
 * @returns A logger instance augmented with `trace_id` when a trace or request id header exists, otherwise the default application logger
 */
function loggerWithTrace(req: IncomingMessage) {
  const traceId = headerValue(req.headers["x-trace-id"]) ?? headerValue(req.headers["x-request-id"]);
  if (!traceId) {
    return appLogger;
  }
  return appLogger.child({ trace_id: traceId });
}

/**
 * Extracts a session ID from an HTTP upgrade request by checking a Bearer Authorization header first, then a named cookie.
 *
 * @param req - The incoming HTTP request for the upgrade handshake
 * @param cookieName - The cookie name to look for when extracting the session ID
 * @returns An object with:
 *  - `status: "ok"` and the validated `sessionId` and `sessionSource` (`"authorization"` or `"cookie"`) when a valid session ID is found;
 *  - `status: "missing"` when no Authorization bearer token or matching cookie is present;
 *  - `status: "invalid"` when a present token or cookie value fails session ID validation.
function extractSessionIdFromUpgrade(req: IncomingMessage, cookieName: string): SessionExtractionResult {
  const authHeader = headerValue(req.headers.authorization);
  const bearerPrefix = "bearer ";
  if (authHeader && authHeader.toLowerCase().startsWith(bearerPrefix)) {
    const token = authHeader.slice(bearerPrefix.length).trim();
    return validateSessionId(token, "authorization");
  }

  const cookieHeader = headerValue(req.headers.cookie);
  if (!cookieHeader) {
    return { status: "missing" };
  }

  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rest] = part.split("=");
    if (!rawName) {
      continue;
    }
    const name = rawName.trim();
    if (name !== cookieName) {
      continue;
    }
    const rawValue = rest.join("=");
    const trimmedValue = rawValue.trim();
    let decoded = trimmedValue;
    try {
      decoded = decodeURIComponent(trimmedValue);
    } catch {
      // Preserve raw value so validation can surface helpful errors.
    }
    return validateSessionId(decoded, "cookie");
  }

  return { status: "missing" };
}

/**
 * Validate and resolve a session for a terminal WebSocket upgrade request.
 *
 * Attempts to extract a session ID from the request (Authorization header or cookie),
 * cleans up expired sessions, and returns the corresponding session record if it exists.
 *
 * @param req - The incoming HTTP upgrade request to inspect for authentication data
 * @param cookieName - The name of the session cookie to check when extracting a session ID
 * @returns An object with `status: "ok"` and the resolved `session`, `sessionId`, and optional `source` when a valid session is found; otherwise `{ status: "error", reason }` describing why authentication failed
 */
function authenticateTerminalRequest(
  req: IncomingMessage,
  cookieName: string,
): { status: "ok"; session: SessionRecord; sessionId: string; source?: SessionSource } | { status: "error"; reason: string } {
  sessionStore.cleanupExpired();
  const sessionResult = extractSessionIdFromUpgrade(req, cookieName);
  if (sessionResult.status === "invalid") {
    return { status: "error", reason: "invalid session" };
  }
  if (sessionResult.status === "missing") {
    return { status: "error", reason: "missing session" };
  }
  const session = sessionStore.getSession(sessionResult.sessionId);
  if (!session) {
    return { status: "error", reason: "unknown session" };
  }
  return { status: "ok", session, sessionId: sessionResult.sessionId, source: sessionResult.source };
}

/**
 * Attempts to increment the active connection count for the given IP address if doing so does not exceed the configured limit.
 *
 * @param ip - Client IP address used as the tracking key
 * @param limit - Maximum allowed concurrent connections for this IP
 * @returns `true` if the connection count was incremented, `false` if the limit was already reached
 */
function incrementConnection(ip: string, limit: number): boolean {
  const current = ipConnectionCounts.get(ip) ?? 0;
  if (current >= limit) {
    return false;
  }
  ipConnectionCounts.set(ip, current + 1);
  return true;
}

/**
 * Decrements the active terminal connection count for a given IP address.
 *
 * If the count reaches zero, the IP entry is removed from the internal tracking map.
 *
 * @param ip - The client IP address whose connection count should be decremented
 */
function decrementConnection(ip: string): void {
  const current = ipConnectionCounts.get(ip) ?? 0;
  if (current <= 1) {
    ipConnectionCounts.delete(ip);
    return;
  }
  ipConnectionCounts.set(ip, current - 1);
}

/**
 * Resolve the maximum allowed terminal WebSocket connections per IP from environment configuration.
 *
 * @returns The positive integer value of `TERMINAL_CONNECTIONS_PER_IP` if set and valid, otherwise the default connection limit.
 */
function resolveConnectionLimitFromEnv(): number {
  const parsed = Number.parseInt(process.env.TERMINAL_CONNECTIONS_PER_IP ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_CONNECTIONS_PER_IP;
}

/**
 * Install and manage the WebSocket-based sandbox terminal upgrade endpoint and connection lifecycle on the provided HTTP/S server.
 *
 * Sets up a no-server WebSocketServer at the module's terminal path, enforces origin allowlist, per-IP connection limits, and session-based authentication; upgrades validated requests into terminal WebSocket connections managed by TerminalManager and records audit events for allowed and denied attempts.
 *
 * @param httpServer - The HTTP or HTTPS server to attach the upgrade handler to
 * @param config - Application configuration used for session cookie name, CORS allowed origins, and trusted proxy CIDRs
 */
export function setupTerminalServer(httpServer: http.Server | https.Server, config: AppConfig): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_TERMINAL_PAYLOAD_BYTES });
  const sessionCookieName = config.auth.oidc.session.cookieName;
  const allowedOrigins = new Set(config.server.cors.allowedOrigins ?? []);
  const connectionLimitPerIp = resolveConnectionLimitFromEnv();
  const terminalManager = new TerminalManager({ logger: appLogger.child({ component: "terminal" }) });

  httpServer.on("close", () => terminalManager.shutdown());

  httpServer.on("upgrade", (request, socket, head) => {
    const { pathname, searchParams } = new URL(request.url ?? "", "http://localhost");
    if (pathname !== TERMINAL_WS_PATH) {
      return;
    }

    markUpgradeHandled(request);
    const logger = loggerWithTrace(request);
    const identifiers = requestIdentifiers(request);
    const ip = resolveClientIp(request, config.server.trustedProxyCidrs);
    const hashedIp = hashIdentifier(ip);
    const origin = headerValue(request.headers["origin"]);

    if (allowedOrigins.size > 0) {
      let originDenialReason: "origin_missing" | "origin_not_allowed" | null = null;
      if (!origin) {
        originDenialReason = "origin_missing";
      } else if (!allowedOrigins.has(origin)) {
        originDenialReason = "origin_not_allowed";
      }

      if (originDenialReason) {
        const safeOrigin = sanitizeHeaderForLog(origin);
        logger.warn({ origin: safeOrigin }, "rejecting terminal connection due to disallowed origin");
        logAuditEvent({
          action: "terminal.connection",
          outcome: "denied",
          resource: "sandbox.terminal",
          requestId: identifiers.requestId,
          traceId: identifiers.traceId,
          details: { reason: originDenialReason, origin: safeOrigin },
        });
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    if (!incrementConnection(ip, connectionLimitPerIp)) {
      logger.warn({ ip: hashedIp }, "rejecting terminal connection due to per-IP limit");
      logAuditEvent({
        action: "terminal.connection",
        outcome: "denied",
        resource: "sandbox.terminal",
        requestId: identifiers.requestId,
        traceId: identifiers.traceId,
        details: { reason: "ip_rate_limited", ip: hashedIp },
      });
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: 60\r\n\r\n");
      socket.destroy();
      return;
    }

    const authResult = authenticateTerminalRequest(request, sessionCookieName);
    if (authResult.status === "error") {
      logger.warn({ reason: authResult.reason }, "rejecting terminal connection due to invalid session");
      logAuditEvent({
        action: "terminal.connection",
        outcome: "denied",
        resource: "sandbox.terminal",
        requestId: identifiers.requestId,
        traceId: identifiers.traceId,
        details: { reason: authResult.reason },
      });
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      decrementConnection(ip);
      return;
    }

    const paramsResult = terminalParamsSchema.safeParse({ sessionId: searchParams.get("sessionId") });
    if (!paramsResult.success || paramsResult.data.sessionId !== authResult.sessionId) {
      logger.warn({ reason: "session mismatch" }, "rejecting terminal connection due to session mismatch");
      logAuditEvent({
        action: "terminal.connection",
        outcome: "denied",
        resource: "sandbox.terminal",
        requestId: identifiers.requestId,
        traceId: identifiers.traceId,
        subject: { sessionId: authResult.session.id, userId: authResult.session.subject },
        details: { reason: "session_mismatch" },
      });
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      decrementConnection(ip);
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.once("close", () => decrementConnection(ip));
      try {
        terminalManager.attach(paramsResult.data.sessionId, ws);
        logAuditEvent({
          action: "terminal.connection",
          outcome: "allowed",
          resource: "sandbox.terminal",
          requestId: identifiers.requestId,
          traceId: identifiers.traceId,
          subject: {
            sessionId: authResult.session.id,
            userId: authResult.session.subject,
            tenantId: authResult.session.tenantId ?? undefined,
            email: authResult.session.email ?? undefined,
          },
          details: { source: authResult.source },
        });
      } catch (error) {
        logger.error({ err: normalizeError(error) }, "failed to attach terminal client");
        ws.close(1011, "unable to start terminal");
        decrementConnection(ip);
      }
    });
  });
}

export { TERMINAL_WS_PATH };