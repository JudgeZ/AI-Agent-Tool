import http from "node:http";
import type https from "node:https";

import { WebSocketServer } from "ws";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import { logAuditEvent } from "../observability/audit.js";
import { hashIdentifier } from "../observability/audit.js";
import { appLogger, normalizeError } from "../observability/logger.js";
import { SessionIdSchema } from "../http/validation.js";
import {
  authenticateSessionFromUpgrade,
  decrementConnectionCount,
  headerValue,
  incrementConnectionCount,
  requestIdentifiers,
  loggerWithTrace,
  resolveClientIp,
  sanitizeHeaderForLog,
} from "../http/wsUtils.js";
import { TerminalManager } from "./TerminalManager.js";
import { markUpgradeHandled } from "../server/upgradeMarkers.js";
const TERMINAL_WS_PATH = "/sandbox/terminal";
const MAX_TERMINAL_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_CONNECTIONS_PER_IP = 20;

const terminalParamsSchema = z.object({
  sessionId: SessionIdSchema,
});

const ipConnectionCounts = new Map<string, number>();

function resolveConnectionLimitFromEnv(): number {
  const parsed = Number.parseInt(process.env.TERMINAL_CONNECTIONS_PER_IP ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_CONNECTIONS_PER_IP;
}

export function setupTerminalServer(httpServer: http.Server | https.Server, config: AppConfig): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_TERMINAL_PAYLOAD_BYTES });
  const sessionCookieName = config.auth.oidc.session.cookieName;
  const allowedOrigins = new Set(config.server.cors.allowedOrigins ?? []);
  const connectionLimitPerIp = resolveConnectionLimitFromEnv();
  const terminalManager = new TerminalManager({ logger: appLogger.child({ component: "terminal" }) });

  httpServer.on("close", () => {
    terminalManager.shutdown();
    ipConnectionCounts.clear();
    wss.close();
  });

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

    if (!incrementConnectionCount(ip, connectionLimitPerIp, ipConnectionCounts)) {
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

    const authResult = authenticateSessionFromUpgrade(request, sessionCookieName);
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
      decrementConnectionCount(ip, ipConnectionCounts);
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
      decrementConnectionCount(ip, ipConnectionCounts);
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      let cleanedUp = false;
      const cleanupConnection = () => {
        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        decrementConnectionCount(ip, ipConnectionCounts);
        ws.off("error", cleanupConnection);
        ws.off("close", cleanupConnection);
      };
      ws.on("close", cleanupConnection);
      ws.on("error", cleanupConnection);
      try {
        const attached = terminalManager.attach(paramsResult.data.sessionId, ws);
        if (attached === "attached" || attached === "pending") {
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
            details: { source: authResult.source, status: attached },
          });
        } else {
          logAuditEvent({
            action: "terminal.connection",
            outcome: "error",
            resource: "sandbox.terminal",
            requestId: identifiers.requestId,
            traceId: identifiers.traceId,
            subject: {
              sessionId: authResult.session.id,
              userId: authResult.session.subject,
              tenantId: authResult.session.tenantId ?? undefined,
              email: authResult.session.email ?? undefined,
            },
            details: { reason: "attach_failed", source: authResult.source },
          });
        }
      } catch (error) {
        logger.error({ err: normalizeError(error) }, "failed to attach terminal client");
        ws.close(1011, "unable to start terminal");
      }
    });
  });
}

export { TERMINAL_WS_PATH };
