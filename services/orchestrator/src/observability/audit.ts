type AuditOutcome = "success" | "failure" | "denied" | "approved" | "rejected";

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

function sanitizeDetails(
  details?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!details) {
    return undefined;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) {
      continue;
    }
    sanitized[key] = value;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function logAuditEvent(event: AuditEvent): void {
  const payload: Record<string, unknown> = {
    level: "audit",
    timestamp: new Date().toISOString(),
    service: "orchestrator",
    action: event.action,
    outcome: event.outcome,
  };

  if (event.resource) {
    payload.resource = event.resource;
  }
  if (event.traceId) {
    payload.trace_id = event.traceId;
  }
  if (event.requestId) {
    payload.request_id = event.requestId;
  }
  if (event.agent) {
    payload.agent = event.agent;
  }
  if (event.subject) {
    payload.subject = {
      session_id: event.subject.sessionId ?? undefined,
      user_id: event.subject.userId ?? undefined,
      tenant_id: event.subject.tenantId ?? undefined,
      email: event.subject.email ?? undefined,
      name: event.subject.name ?? undefined,
      roles:
        event.subject.roles && event.subject.roles.length > 0
          ? event.subject.roles
          : undefined,
      scopes:
        event.subject.scopes && event.subject.scopes.length > 0
          ? event.subject.scopes
          : undefined,
    };
  }
  if (event.error) {
    payload.error = event.error;
  }

  const details = sanitizeDetails(event.details);
  if (details) {
    payload.details = details;
  }

  try {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Failed to serialize audit event", error);
  }
}
