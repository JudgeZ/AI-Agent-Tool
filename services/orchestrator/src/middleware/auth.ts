import type { AppConfig } from "../config.js";
import { getSessionStore, type SessionRecord } from "../auth/SessionStore.js";
import { extractSessionId } from "../auth/sessionValidation.js";
import { logAuditEvent } from "../observability/audit.js";
import type { ExtendedRequest } from "../http/types.js";
import type { Response, NextFunction } from "express";

export async function attachSession(
  req: ExtendedRequest,
  config: AppConfig,
): Promise<SessionRecord | undefined> {
  const oidcConfig = config.auth.oidc;
  if (!oidcConfig.enabled) {
    req.auth = undefined;
    return undefined;
  }
  const sessionStore = await getSessionStore();
  await sessionStore.cleanupExpired();
  const sessionResult = extractSessionId(req, oidcConfig.session.cookieName);
  if (sessionResult.status === "invalid") {
    req.auth = {
      error: {
        code: "invalid_session",
        source: sessionResult.source,
        issues: sessionResult.issues,
      },
    };
    const requestId = req.header("x-request-id") ?? undefined;
    const traceId = req.header("x-trace-id") ?? undefined;
    logAuditEvent({
      action: "auth.session.attach",
      outcome: "failure",
      requestId,
      traceId,
      resource: "auth.session",
      details: {
        reason: "invalid session id",
        source: sessionResult.source,
        issues: sessionResult.issues,
        path: req.originalUrl,
      },
    });
    return undefined;
  }
  if (sessionResult.status === "missing") {
    req.auth = undefined;
    return undefined;
  }
  const session = await sessionStore.getSession(sessionResult.sessionId);
  if (session) {
    req.auth = { session };
    return session;
  }
  req.auth = undefined;
  return undefined;
}

export function attachSessionMiddleware(config: AppConfig) {
  return async (req: ExtendedRequest, _res: Response, next: NextFunction) => {
    try {
      await attachSession(req, config);
      next();
    } catch (error) {
      next(error);
    }
  };
}
