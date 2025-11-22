import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { ServerResponse } from "node:http";
import type { Response, Request } from "express";

import type { SessionRecord } from "../auth/SessionStore.js";
import type { PlanSubject } from "../plan/index.js";
import type { AuditSubject } from "../observability/audit.js";
import type { DenyReason } from "../policy/PolicyEnforcer.js";
import type { ApprovalDecision } from "../queue/PlanQueueRuntime.js";
import { getRequestContext, updateContextIdentifiers } from "../observability/requestContext.js";
import { logAuditEvent } from "../observability/audit.js";
import { respondWithError } from "./errors.js";
import type { InvalidTenantIdentifierError } from "../tenants/tenantIds.js";
import type { ExtendedRequest, AuthError } from "./types.js";
import type { PlanStepEvent } from "../plan/events.js";

export function toPlanSubject(session: SessionRecord): PlanSubject {
  return {
    sessionId: session.id,
    tenantId: session.tenantId,
    userId: session.subject,
    email: session.email,
    name: session.name,
    roles: session.roles,
    scopes: session.scopes,
  };
}

export function toAuditSubject(
  session: SessionRecord | undefined,
): AuditSubject | undefined {
  if (!session) {
    return undefined;
  }
  return {
    sessionId: session.id,
    userId: session.subject,
    tenantId: session.tenantId,
    email: session.email,
    name: session.name,
    roles: session.roles,
    scopes: session.scopes,
  };
}

export function toPolicySubject(session: SessionRecord | undefined) {
  if (!session) {
    return undefined;
  }
  return {
    sessionId: session.id,
    tenant: session.tenantId,
    roles: session.roles,
    scopes: session.scopes,
    user: {
      id: session.subject,
      email: session.email ?? undefined,
      name: session.name ?? undefined,
    },
  };
}

export function subjectsMatch(
  owner: PlanSubject | undefined,
  candidate: PlanSubject | undefined,
): boolean {
  if (!owner) {
    return true;
  }
  if (!candidate) {
    return false;
  }
  if (
    owner.sessionId &&
    candidate.sessionId &&
    owner.sessionId === candidate.sessionId
  ) {
    return true;
  }
  const tenantAligned = owner.tenantId
    ? owner.tenantId === candidate.tenantId
    : true;
  if (owner.userId && candidate.userId && owner.userId === candidate.userId) {
    return tenantAligned;
  }
  if (owner.email && candidate.email && owner.email === candidate.email) {
    return tenantAligned;
  }
  if (!owner.userId && !owner.email && owner.tenantId && candidate.tenantId) {
    return owner.tenantId === candidate.tenantId;
  }
  return false;
}

export function getRequestIds(res: Response): { requestId: string; traceId: string } {
  const context = getRequestContext();
  const requestId =
    context?.requestId ?? String(res.locals.requestId ?? randomUUID());
  const traceId =
    context?.traceId ?? String(res.locals.traceId ?? randomUUID());
  updateContextIdentifiers({ requestId, traceId });
  return { requestId, traceId };
}

export function buildPolicyErrorMessage(deny: DenyReason[]): string {
  if (deny.length === 0) {
    return "policy denied";
  }
  const first = deny[0];
  if (first.capability) {
    return `${first.capability} denied`;
  }
  return first.reason ?? "policy denied";
}

export function formatApprovalSummary(
  decision: ApprovalDecision,
  rationale: string | undefined,
  fallback: string | undefined,
): string {
  if (rationale && rationale.length > 0) {
    const prefix = decision === "approved" ? "Approved" : "Rejected";
    return `${prefix}: ${rationale}`;
  }
  if (fallback && fallback.length > 0) {
    return fallback;
  }
  return decision === "approved" ? "Approved for execution" : "Step rejected";
}

export async function waitForDrain(stream: ServerResponse): Promise<void> {
  if (stream.writableEnded || stream.destroyed) {
    return;
  }
  await once(stream, "drain");
}

export function resolveAuthFailure(
  req: ExtendedRequest,
): {
  status: number;
  code: "unauthorized" | "invalid_request";
  message: string;
  reason: string;
  details?: Record<string, unknown>;
} {
  const error = req.auth?.error;
  if (error?.code === "invalid_session") {
    return {
      status: 400,
      code: "invalid_request",
      message: "invalid session",
      reason: "invalid_session",
      details: { source: error.source, issues: error.issues },
    };
  }
  return {
    status: 401,
    code: "unauthorized",
    message: "authentication required",
    reason: "authentication_required",
  };
}

export function buildAuthFailureAuditDetails(
  failure: ReturnType<typeof resolveAuthFailure>,
): Record<string, unknown> {
  if (failure.details) {
    return { reason: failure.reason, ...failure.details };
  }
  return { reason: failure.reason };
}

export function respondWithInvalidTenant(
  res: Response,
  action: string,
  agent: string | undefined,
  error: InvalidTenantIdentifierError,
): void {
  respondWithError(res, 400, {
    code: "invalid_request",
    message: error.message,
  });
  const { requestId, traceId } = getRequestIds(res);
  logAuditEvent({
    action,
    outcome: "failure",
    agent,
    requestId,
    traceId,
    details: { reason: "invalid_tenant" },
    error: error.message,
  });
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function sanitizePlanEvent(event: PlanStepEvent): PlanStepEvent {
  const cloned: Mutable<PlanStepEvent> = { ...event, step: { ...event.step } };
  cloned.step.labels = [...(event.step.labels ?? [])];
  return cloned;
}

export function setNoCacheHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
}

export function shouldStream(req: Request): boolean {
  const accept = req.headers.accept;
  if (!accept) {
    return false;
  }
  return accept
    .split(",")
    .some((entry) => entry.trim().toLowerCase() === "text/event-stream");
}
