import type { IncomingMessage } from "node:http";

import ipaddr from "ipaddr.js";

import { sessionStore, type SessionRecord } from "../auth/SessionStore.js";
import { validateSessionId, type SessionExtractionResult, type SessionSource } from "../auth/sessionValidation.js";
import { appLogger } from "../observability/logger.js";

export type IpAddress = ipaddr.IPv4 | ipaddr.IPv6;

export function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.find((entry) => typeof entry === "string" && entry.trim().length > 0)?.trim();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

export function sanitizeHeaderForLog(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/\r|\n/g, "").slice(0, 512);
}

export function parseIpAddress(raw: string | undefined): IpAddress | undefined {
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

export function isTrustedProxyIp(address: IpAddress, trustedProxyCidrs: readonly string[]): boolean {
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

export function isPrivateOrLoopback(address: IpAddress): boolean {
  if (address.kind() === "ipv4") {
    const range = (address as ipaddr.IPv4).range();
    return range === "loopback" || range === "linkLocal" || range === "private";
  }
  const range = (address as ipaddr.IPv6).range();
  return range === "loopback" || range === "linkLocal" || range === "uniqueLocal";
}

export function resolveClientIp(req: IncomingMessage, trustedProxyCidrs: readonly string[]): string {
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

export function requestIdentifiers(req: IncomingMessage): { requestId?: string; traceId?: string } {
  return {
    requestId: headerValue(req.headers["x-request-id"]),
    traceId: headerValue(req.headers["x-trace-id"]),
  };
}

export function loggerWithTrace(req: IncomingMessage) {
  const traceId = headerValue(req.headers["x-trace-id"]) ?? headerValue(req.headers["x-request-id"]);
  if (!traceId) {
    return appLogger;
  }
  return appLogger.child({ trace_id: traceId });
}

export function extractSessionIdFromUpgrade(req: IncomingMessage, cookieName: string): SessionExtractionResult {
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

export function authenticateSessionFromUpgrade(
  req: IncomingMessage,
  cookieName: string,
):
  | { status: "ok"; session: SessionRecord; sessionId: string; source?: SessionSource }
  | { status: "error"; reason: string; source?: SessionSource } {
  sessionStore.cleanupExpired();
  const sessionResult = extractSessionIdFromUpgrade(req, cookieName);
  if (sessionResult.status === "invalid") {
    return { status: "error", reason: "invalid session", source: sessionResult.source };
  }
  if (sessionResult.status === "missing") {
    return { status: "error", reason: "missing session" };
  }
  const session = sessionStore.getSession(sessionResult.sessionId);
  if (!session) {
    return { status: "error", reason: "unknown session", source: sessionResult.source };
  }
  return { status: "ok", session, sessionId: sessionResult.sessionId, source: sessionResult.source };
}

export function auditSubjectFromSession(session: SessionRecord | undefined) {
  if (!session) {
    return undefined;
  }
  return {
    sessionId: session.id,
    userId: session.subject,
    tenantId: session.tenantId ?? undefined,
    email: session.email ?? undefined,
  };
}

export function incrementConnectionCount(ip: string, limit: number, counts: Map<string, number>): boolean {
  const current = counts.get(ip) ?? 0;
  if (current >= limit) {
    return false;
  }
  counts.set(ip, current + 1);
  return true;
}

export function decrementConnectionCount(ip: string, counts: Map<string, number>): void {
  const current = counts.get(ip) ?? 0;
  if (current <= 1) {
    counts.delete(ip);
    return;
  }
  counts.set(ip, current - 1);
}
