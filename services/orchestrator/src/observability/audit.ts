import crypto from "node:crypto";

import auditLogger from "./logger.js";
import {
  getRequestContext,
  setActorInContext,
  type RequestContext
} from "./requestContext.js";

export type AuditOutcome =
  | "success"
  | "failure"
  | "denied"
  | "approved"
  | "rejected";

export type AuditSubject = {
  sessionId?: string;
  userId?: string;
  tenantId?: string;
  email?: string | null;
  name?: string | null;
  roles?: string[];
  scopes?: string[];
};

export type AuditEvent = {
  action: string;
  outcome: AuditOutcome;
  resource?: string;
  traceId?: string;
  requestId?: string;
  agent?: string;
  subject?: AuditSubject;
  details?: Record<string, unknown>;
  error?: string;
};

const serviceName = process.env.ORCHESTRATOR_SERVICE_NAME ?? "orchestrator";
const hashSalt =
  process.env.AUDIT_HASH_SALT ??
  process.env.ORCHESTRATOR_AUDIT_SALT ??
  process.env.OSS_AUDIT_SALT ??
  "";
const identifierHashSalt = hashSalt || `${serviceName}-audit-salt`;
const HASH_ITERATIONS = 310_000;
const HASH_KEY_LENGTH = 32;
const HASH_DIGEST = "sha256";
const HASH_CACHE_LIMIT = 2048;

const hashCache = new Map<string, string>();

function rememberHash(value: string, hash: string): void {
  hashCache.set(value, hash);
  if (hashCache.size > HASH_CACHE_LIMIT) {
    const oldest = hashCache.keys().next().value;
    if (oldest !== undefined) {
      hashCache.delete(oldest);
    }
  }
}

const secretKeyPatterns = [
  /token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /authorization/i,
  /api[_-]?key/i,
  /client[_-]?secret/i
];

function selectLevel(outcome: AuditOutcome): "info" | "warn" | "error" {
  switch (outcome) {
    case "failure":
      return "error";
    case "denied":
    case "rejected":
      return "warn";
    default:
      return "info";
  }
}

export function hashIdentifier(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const cached = hashCache.get(trimmed);
  if (cached) {
    return cached;
  }
  const derived = crypto
    .pbkdf2Sync(trimmed, identifierHashSalt, HASH_ITERATIONS, HASH_KEY_LENGTH, HASH_DIGEST)
    .toString("hex");
  rememberHash(trimmed, derived);
  return derived;
}

function shouldMask(key?: string): boolean {
  if (!key) {
    return false;
  }
  return secretKeyPatterns.some((pattern) => pattern.test(key));
}

function sanitizeValue(value: unknown, key?: string): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string" && shouldMask(key)) {
    return "[redacted]";
  }
  if (Array.isArray(value)) {
    const sanitizedArray = value
      .map((item) => sanitizeValue(item))
      .filter((item) => item !== undefined);
    return sanitizedArray.length > 0 ? sanitizedArray : undefined;
  }
  if (typeof value === "object") {
    const sanitizedObject: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(
      value as Record<string, unknown>
    )) {
      const sanitized = sanitizeValue(nestedValue, nestedKey);
      if (sanitized !== undefined) {
        sanitizedObject[nestedKey] = sanitized;
      }
    }
    return Object.keys(sanitizedObject).length > 0
      ? sanitizedObject
      : undefined;
  }
  return value;
}

function sanitizeDetails(
  details?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!details) {
    return undefined;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    const sanitizedValue = sanitizeValue(value, key);
    if (sanitizedValue !== undefined) {
      sanitized[key] = sanitizedValue;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function buildSubject(subject: AuditSubject | undefined) {
  if (!subject) {
    return undefined;
  }
  const payload: Record<string, unknown> = {};
  const sessionHash = hashIdentifier(subject.sessionId);
  const userHash = hashIdentifier(subject.userId);
  const tenantHash = hashIdentifier(subject.tenantId);
  const emailHash = hashIdentifier(subject.email ?? undefined);

  if (sessionHash) {
    payload.session_id = sessionHash;
  }
  if (userHash) {
    payload.user_id = userHash;
  }
  if (tenantHash) {
    payload.tenant_id = tenantHash;
  }
  if (emailHash) {
    payload.email_hash = emailHash;
  }
  if (subject.roles && subject.roles.length > 0) {
    payload.roles = subject.roles;
  }
  if (subject.scopes && subject.scopes.length > 0) {
    payload.scopes = subject.scopes;
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}

function deriveActorId(event: AuditEvent, context?: RequestContext): string {
  if (context?.actorId) {
    return context.actorId;
  }
  const subject = event.subject;
  const candidate =
    subject?.sessionId ??
    subject?.userId ??
    subject?.email ??
    subject?.tenantId ??
    event.agent ??
    undefined;
  return hashIdentifier(candidate) ?? hashIdentifier("anonymous")!;
}

export function logAuditEvent(event: AuditEvent): void {
  const context = getRequestContext();
  const { capability, ...details } = event.details ?? {};
  const sanitizedDetails = sanitizeDetails(details);

  const actorId = deriveActorId(event, context) ?? "anonymous";
  if (context && actorId) {
    setActorInContext(actorId);
  }

  const requestId = event.requestId ?? context?.requestId;
  const traceId = event.traceId ?? context?.traceId;

  const level = selectLevel(event.outcome);
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    service: serviceName,
    event: event.action,
    outcome: event.outcome,
    target: event.resource ?? "unspecified",
    actor_id: actorId,
    redacted_details: sanitizedDetails ?? {}
  };

  if (capability && typeof capability === "string") {
    payload.capability = capability;
  }
  if (requestId) {
    payload.request_id = requestId;
  }
  if (traceId) {
    payload.trace_id = traceId;
  }
  if (event.agent) {
    payload.agent = event.agent;
  }
  if (event.error) {
    payload.error = event.error;
  }

  const subjectPayload = buildSubject(event.subject);
  if (subjectPayload) {
    payload.subject = subjectPayload;
  }

  try {
    auditLogger[level](payload);
  } catch (error) {
    auditLogger.error(
      { err: error instanceof Error ? error : new Error(String(error)) },
      "audit.log_failure"
    );
  }
}

export function __clearAuditHashCacheForTests(): void {
  hashCache.clear();
}
