/**
 * Rate limiting wrapper for marketplace endpoints
 */

import type { Request, Response, NextFunction } from "express";
import { HttpRateLimiter } from "../rateLimit/HttpRateLimiter";
import { createRequestIdentity, buildRateLimitBuckets } from "../http/requestIdentity.js";
import { recordRateLimitOutcome } from "../observability/metrics.js";
import { respondWithError } from "../http/errors.js";
import { logAuditEvent, type AuditSubject } from "../observability/audit.js";
import { getRequestContext } from "../observability/requestContext.js";
import type { SessionRecord } from "../auth/SessionStore.js";

interface ExtendedRequest extends Request {
  auth?: {
    session?: SessionRecord;
  };
}

interface RateLimitConfig {
  requestsPerMinute: number;
  requestsPerHour: number;
}

// Define rate limits for each endpoint type
export const MARKETPLACE_RATE_LIMITS = {
  // Write operations - more restrictive
  publish: {
    requestsPerMinute: 10,
    requestsPerHour: 100,
  },
  update: {
    requestsPerMinute: 20,
    requestsPerHour: 200,
  },
  delete: {
    requestsPerMinute: 10,
    requestsPerHour: 100,
  },
  review: {
    requestsPerMinute: 15,
    requestsPerHour: 150,
  },

  // Read operations - more permissive
  search: {
    requestsPerMinute: 60,
    requestsPerHour: 600,
  },
  get: {
    requestsPerMinute: 100,
    requestsPerHour: 1000,
  },
  trending: {
    requestsPerMinute: 30,
    requestsPerHour: 300,
  },
  featured: {
    requestsPerMinute: 30,
    requestsPerHour: 300,
  },
  myTools: {
    requestsPerMinute: 30,
    requestsPerHour: 300,
  },

  // Admin operations
  archive: {
    requestsPerMinute: 5,
    requestsPerHour: 50,
  },
  deprecate: {
    requestsPerMinute: 5,
    requestsPerHour: 50,
  },
};

/**
 * Create rate limiting middleware for a marketplace endpoint
 */
export function createMarketplaceRateLimiter(
  rateLimiter: HttpRateLimiter,
  endpoint: string,
  config: RateLimitConfig,
) {
  return async (req: ExtendedRequest, res: Response, next: NextFunction) => {
    const identity = createRequestIdentity(req as any, {} as any);
    const buckets: {
      endpoint: string;
      identityType: "ip" | "identity";
      windowMs: number;
      maxRequests: number;
    }[] = [
        {
          endpoint: `marketplace.${endpoint}`,
          identityType: "ip",
          windowMs: 60000,
          maxRequests: config.requestsPerMinute,
        },
        {
          endpoint: `marketplace.${endpoint}`,
          identityType: "ip",
          windowMs: 3600000, // 1 hour
          maxRequests: config.requestsPerHour,
        },
      ];

    for (const bucket of buckets) {
      const key = `marketplace.${endpoint}:${bucket.identityType}:${bucket.identityType === "identity"
        ? (identity.subjectId ?? identity.ip)
        : identity.ip
        }`;

      const result = await rateLimiter.checkRateLimit(key, {
        limit: bucket.maxRequests,
        window: bucket.windowMs,
      });

      recordRateLimitOutcome(`marketplace.${endpoint}`, bucket.identityType, result.allowed);

      if (!result.allowed) {
        // Get request context
        const context = getRequestContext();
        const requestId = context?.requestId ?? "unknown";
        const traceId = context?.traceId ?? "unknown";

        respondWithError(
          res,
          429,
          {
            code: "too_many_requests",
            message: `marketplace ${endpoint} rate limit exceeded`,
          },
          result.retryAfterMs ? { retryAfterMs: result.retryAfterMs } : undefined,
        );

        // Log audit event
        const subject = toAuditSubject(req.auth?.session);
        logAuditEvent({
          action: `marketplace.${endpoint}`,
          outcome: "denied",
          subject,
          requestId,
          traceId,
          details: { reason: "rate_limited" },
        });

        return;
      }
    }

    // Rate limit passed, continue to next middleware
    next();
  };
}

function toAuditSubject(
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

/**
 * Apply rate limiting to all marketplace routes
 */
export function applyMarketplaceRateLimiting(
  router: any,
  rateLimiter: HttpRateLimiter,
) {
  // Helper to add rate limiting before route handler
  const wrapRoute = (
    method: string,
    path: string,
    endpoint: string,
    config: RateLimitConfig,
    handler: any,
  ) => {
    const middleware = createMarketplaceRateLimiter(rateLimiter, endpoint, config);
    router[method](path, middleware, handler);
  };

  return { wrapRoute };
}
