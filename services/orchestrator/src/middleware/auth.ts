import type { AppConfig } from "../config.js";
import { sessionStore, type SessionRecord } from "../auth/SessionStore.js";
import { extractSessionId } from "../auth/sessionValidation.js";
import { logAuditEvent } from "../observability/audit.js";
import { appLogger, normalizeError } from "../observability/logger.js";
import type { ExtendedRequest } from "../http/types.js";
import type { Response, NextFunction } from "express";

const logger = appLogger.child({ subsystem: "auth-middleware" });

export async function attachSession(
  req: ExtendedRequest,
  config: AppConfig,
): Promise<SessionRecord | undefined> {
  const oidcConfig = config.auth.oidc;
  if (!oidcConfig.enabled) {
    req.auth = undefined;
    return undefined;
  }

  try {
    await sessionStore.cleanupExpired();
  } catch (error) {
    // Log but don't fail the request - cleanup is non-critical
    logger.warn(
      { err: normalizeError(error), event: "auth.session.cleanup_failed" },
      "Failed to cleanup expired sessions",
    );
  }

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

  try {
    const session = await sessionStore.getSession(sessionResult.sessionId);
    if (session) {
      req.auth = { session };
      return session;
    }
  } catch (error) {
    // Log and treat as missing session
    logger.warn(
      { err: normalizeError(error), sessionId: sessionResult.sessionId, event: "auth.session.get_failed" },
      "Failed to retrieve session from store",
    );
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
      // In Express 4, unhandled async errors cause requests to hang.
      // Pass error to Express error handling middleware.
      next(error);
    }
  };
}

