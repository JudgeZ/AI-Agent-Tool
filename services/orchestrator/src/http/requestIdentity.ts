import type { Request } from "express";

import type { AppConfig, IdentityAwareRateLimitConfig } from "../config.js";
import type { PlanSubject } from "../plan/validation.js";
import { resolveClientIp } from "./clientIp.js";

const MAX_AGENT_NAME_LENGTH = 128;
const MIN_PRINTABLE_ASCII = 0x20; // Space
const MAX_PRINTABLE_ASCII = 0x7e; // Tilde (~)

export type RequestIdentity = {
  ip: string;
  subjectId?: string;
  agentName?: string;
};

export type RateLimitBucket = {
  endpoint: string;
  identityType: "ip" | "identity";
  windowMs: number;
  maxRequests: number;
};

export function createRequestIdentity(
  req: Request,
  config: AppConfig,
  subject?: PlanSubject,
): RequestIdentity {
  const ip = resolveClientIp(req, config.server.trustedProxyCidrs);
  const identity: RequestIdentity = { ip };
  const subjectId = subject?.sessionId ?? subject?.userId ?? subject?.tenantId;
  if (subjectId) {
    identity.subjectId = subjectId;
  }
  const agent = subject ? extractAgent(req) : undefined;
  if (agent) {
    identity.agentName = agent;
  }
  return identity;
}

export function buildRateLimitKey(identity: RequestIdentity): string {
  if (identity.subjectId) {
    return `subject:${identity.subjectId}`;
  }
  return `ip:${identity.ip}`;
}

export function buildRateLimitBuckets(
  endpoint: string,
  config: IdentityAwareRateLimitConfig,
): RateLimitBucket[] {
  const buckets: RateLimitBucket[] = [
    {
      endpoint,
      identityType: "ip",
      windowMs: sanitizePositive(config.windowMs),
      maxRequests: sanitizePositive(config.maxRequests),
    },
  ];

  if (hasIdentityLimits(config)) {
    buckets.push({
      endpoint,
      identityType: "identity",
      windowMs: sanitizePositive(config.identityWindowMs ?? 0),
      maxRequests: sanitizePositive(config.identityMaxRequests ?? 0),
    });
  }

  return buckets;
}

export function extractAgent(req: Request): string | undefined {
  const headerValue = readHeaderValue(req, "X-Agent");
  if (headerValue !== undefined) {
    const sanitizedHeader = sanitizeAgentName(headerValue);
    if (sanitizedHeader !== undefined) {
      return sanitizedHeader;
    }
  }

  return sanitizeAgentName(readAgentFromBody(req.body));
}

export function normalizeRedirectIdentity(value: string | undefined | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    const portSegment = parsed.port ? `:${parsed.port}` : "";
    return `${parsed.hostname.toLowerCase()}${portSegment}`;
  } catch {
    return trimmed;
  }
}

export function readHeaderValue(req: Request, name: string): string | undefined {
  if (typeof req.header === "function") {
    const value = req.header(name);
    if (typeof value === "string") {
      return value;
    }
  }
  const headers = req.headers as Record<string, unknown> | undefined;
  if (!headers) {
    return undefined;
  }
  const normalizedName = name.toLowerCase();
  const candidates = [headers[name], headers[normalizedName]];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      return candidate;
    }
    if (Array.isArray(candidate) && candidate.length > 0) {
      const first = candidate.find((entry) => typeof entry === "string");
      if (typeof first === "string") {
        return first;
      }
    }
  }
  return undefined;
}

function readAgentFromBody(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const candidate = (body as Record<string, unknown>).agent;
  return typeof candidate === "string" ? candidate : undefined;
}

function sanitizeAgentName(candidate: unknown): string | undefined {
  if (typeof candidate !== "string") {
    return undefined;
  }
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_AGENT_NAME_LENGTH) {
    return undefined;
  }
  // Restrict agent identifiers to printable ASCII to protect log formatting and
  // ensure compatibility with downstream rate limiting keys.
  for (const char of trimmed) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint < MIN_PRINTABLE_ASCII || codePoint > MAX_PRINTABLE_ASCII) {
      return undefined;
    }
  }
  return trimmed;
}

function hasIdentityLimits(config: IdentityAwareRateLimitConfig): boolean {
  const windowMs = config.identityWindowMs;
  const maxRequests = config.identityMaxRequests;
  if (windowMs === undefined || windowMs === null || maxRequests === undefined || maxRequests === null) {
    return false;
  }
  return sanitizePositive(windowMs) > 0 && sanitizePositive(maxRequests) > 0;
}

function sanitizePositive(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}
