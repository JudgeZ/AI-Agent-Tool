/**
 * Marketplace API routes
 */

import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { Logger } from "pino";
import { MarketplaceService } from "./MarketplaceService.js";
import {
  ToolPublishRequestSchema,
  ToolSearchQuerySchema,
  ToolVersionUpdateSchema,
  ToolReviewSchema,
  type ToolPublishRequest,
  type ToolSearchQuery,
  type ToolVersionUpdate,
  type ToolReview,
  formatVersion,
} from "./types.js";
import { formatValidationIssues } from "../http/validation.js";
import {
  respondWithError,
  respondWithValidationError,
  respondWithUnexpectedError,
} from "../http/errors.js";
import { logAuditEvent, type AuditSubject } from "../observability/audit.js";
import { getPolicyEnforcer } from "../policy/PolicyEnforcer.js";
import { getRequestContext } from "../observability/requestContext.js";
import type { SessionRecord } from "../auth/SessionStore.js";
import {
  createRequestIdentity,
  buildRateLimitBuckets,
} from "../http/requestIdentity.js";
import {
  HttpRateLimiter,
  type RateLimitResult,
} from "../rateLimit/HttpRateLimiter.js";
import { recordRateLimitOutcome } from "../observability/metrics.js";

interface ExtendedRequest extends Request {
  auth?: {
    session?: SessionRecord;
    error?: {
      code: string;
      source: string;
      issues: Array<{ path: string; message: string }>;
    };
  };
}

function toPolicySubject(session: SessionRecord | undefined) {
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

function getRequestIds(res: Response): { requestId: string; traceId: string } {
  const context = getRequestContext();
  const requestId =
    context?.requestId ?? String(res.locals.requestId ?? "unknown");
  const traceId = context?.traceId ?? String(res.locals.traceId ?? "unknown");
  return { requestId, traceId };
}

function requireAuth(
  req: ExtendedRequest,
  res: Response,
): SessionRecord | null {
  if (!req.auth?.session) {
    respondWithError(res, 401, {
      code: "unauthorized",
      message: "authentication required",
    });
    return null;
  }
  return req.auth.session;
}

export interface MarketplaceRoutesConfig {
  service: MarketplaceService;
  logger: Logger;
  requireAuth: boolean;
  runMode: "development" | "production";
  rateLimiter?: HttpRateLimiter;
  rateLimits?: {
    requestsPerMinute?: number;
    requestsPerHour?: number;
  };
}

/**
 * Helper function to enforce rate limiting
 */
async function enforceMarketplaceRateLimit(
  limiter: HttpRateLimiter,
  endpoint: string,
  req: ExtendedRequest,
  res: Response,
  limits: { requestsPerMinute?: number; requestsPerHour?: number },
): Promise<boolean> {
  const identity = createRequestIdentity(req as any, {
    server: { trustedProxyCidrs: [] },
  } as any);
  const buckets: {
    endpoint: string;
    identityType: "ip" | "identity";
    windowMs: number;
    maxRequests: number;
  }[] = [
      {
        endpoint,
        identityType: "ip",
        windowMs: 60000,
        maxRequests: limits.requestsPerMinute ?? 60,
      },
      {
        endpoint,
        identityType: "ip",
        windowMs: 3600000,
        maxRequests: limits.requestsPerHour ?? 600,
      },
    ];

  for (const bucket of buckets) {
    const key = `${endpoint}:${bucket.identityType}:${bucket.identityType === "identity"
        ? identity.subjectId ?? identity.ip
        : identity.ip
      }`;
    const result = await limiter.checkRateLimit(key, {
      limit: bucket.maxRequests,
      window: bucket.windowMs,
    });

    recordRateLimitOutcome(endpoint, bucket.identityType, result.allowed);

    if (!result.allowed) {
      respondWithError(
        res,
        429,
        {
          code: "too_many_requests",
          message: `marketplace ${endpoint} rate limit exceeded`,
        },
        result.retryAfterMs ? { retryAfterMs: result.retryAfterMs } : undefined,
      );
      return false;
    }
  }

  return true;
}

/**
 * Create marketplace API router
 */
export function createMarketplaceRouter(
  config: MarketplaceRoutesConfig,
): Router {
  const router = Router();
  const { service, logger, runMode } = config;
  const policy = getPolicyEnforcer();
  const rateLimiter = config.rateLimiter || new HttpRateLimiter();
  const rateLimits = config.rateLimits || {
    requestsPerMinute: 30,
    requestsPerHour: 300,
  };

  /**
   * POST /marketplace/tools
   * Publish a new tool to the marketplace
   */
  router.post("/tools", async (req: Request, res: Response) => {
    const extendedReq = req as ExtendedRequest;
    const session = requireAuth(extendedReq, res);
    if (!session) return;

    const subject = toAuditSubject(session);
    const { requestId, traceId } = getRequestIds(res);

    // Rate limiting check
    const rateLimitAllowed = await enforceMarketplaceRateLimit(
      rateLimiter,
      "marketplace.tools.publish",
      extendedReq,
      res,
      rateLimits,
    );
    if (!rateLimitAllowed) {
      logAuditEvent({
        action: "marketplace.tool.publish",
        outcome: "denied",
        subject,
        requestId,
        traceId,
        details: { reason: "rate_limited" },
      });
      return;
    }

    // Policy check
    const policyDecision = await policy.enforceHttpAction({
      action: "http.post.marketplace.tools",
      requiredCapabilities: ["marketplace.publish"],
      traceId,
      subject: toPolicySubject(session),
      runMode,
    });

    if (!policyDecision.allow) {
      respondWithError(res, 403, {
        code: "forbidden",
        message: "marketplace publishing not allowed",
        details: policyDecision.deny,
      });
      logAuditEvent({
        action: "marketplace.tool.publish",
        outcome: "denied",
        subject,
        requestId,
        traceId,
        details: { deny: policyDecision.deny },
      });
      return;
    }

    // Validate request
    const parsed = ToolPublishRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      respondWithValidationError(
        res,
        formatValidationIssues(parsed.error.issues),
      );
      logAuditEvent({
        action: "marketplace.tool.publish",
        outcome: "failure",
        subject,
        requestId,
        traceId,
        details: { reason: "invalid_request" },
      });
      return;
    }

    try {
      const publishRequest: ToolPublishRequest = parsed.data;

      if (!session.tenantId) {
        res.status(403).json({
          error: "Tenant ID is required for publishing",
          requestId,
          traceId,
        });
        return;
      }

      const listing = await service.publishTool(publishRequest, {
        tenantId: session.tenantId,
        userId: session.subject,
        name: session.name ?? undefined,
        email: session.email ?? undefined,
      });

      res.status(201).json({ tool: listing, requestId, traceId });

      logAuditEvent({
        action: "marketplace.tool.publish",
        outcome: "success",
        subject,
        requestId,
        traceId,
        details: {
          toolId: listing.id,
          version: formatVersion(listing.manifest.version),
          status: listing.status,
        },
      });
    } catch (error) {
      logger.error({ err: error }, "failed to publish tool");
      respondWithUnexpectedError(res, error);
      logAuditEvent({
        action: "marketplace.tool.publish",
        outcome: "failure",
        subject,
        requestId,
        traceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /marketplace/tools
   * Search marketplace tools
   */
  router.get("/tools", async (req: Request, res: Response) => {
    const extendedReq = req as ExtendedRequest;
    const { requestId, traceId } = getRequestIds(res);

    // Rate limiting check (higher limit for search)
    const searchRateLimits = {
      requestsPerMinute: 60,
      requestsPerHour: 600,
    };
    const rateLimitAllowed = await enforceMarketplaceRateLimit(
      rateLimiter,
      "marketplace.tools.search",
      extendedReq,
      res,
      searchRateLimits,
    );
    if (!rateLimitAllowed) {
      logAuditEvent({
        action: "marketplace.tools.search",
        outcome: "denied",
        subject: toAuditSubject(extendedReq.auth?.session),
        requestId,
        traceId,
        details: { reason: "rate_limited" },
      });
      return;
    }

    // Parse query parameters
    const queryParams = {
      ...req.query,
      capabilities: req.query.capabilities
        ? Array.isArray(req.query.capabilities)
          ? req.query.capabilities
          : [req.query.capabilities]
        : undefined,
      tags: req.query.tags
        ? Array.isArray(req.query.tags)
          ? req.query.tags
          : [req.query.tags]
        : undefined,
      limit: req.query.limit
        ? parseInt(req.query.limit as string, 10)
        : undefined,
      offset: req.query.offset
        ? parseInt(req.query.offset as string, 10)
        : undefined,
      minRating: req.query.minRating
        ? parseFloat(req.query.minRating as string)
        : undefined,
    };

    const parsed = ToolSearchQuerySchema.safeParse(queryParams);
    if (!parsed.success) {
      respondWithValidationError(
        res,
        formatValidationIssues(parsed.error.issues),
      );
      return;
    }

    try {
      const query: ToolSearchQuery = parsed.data;
      const results = await service.searchTools(query);

      res.json({
        tools: results.items,
        total: results.total,
        limit: results.limit,
        offset: results.offset,
        requestId,
        traceId,
      });

      logAuditEvent({
        action: "marketplace.tools.search",
        outcome: "success",
        subject: toAuditSubject(extendedReq.auth?.session),
        requestId,
        traceId,
        details: { query: query.q, results: results.items.length },
      });
    } catch (error) {
      logger.error({ err: error }, "failed to search tools");
      respondWithUnexpectedError(res, error);
    }
  });

  /**
   * GET /marketplace/tools/:toolId
   * Get a specific tool
   */
  router.get("/tools/:toolId", async (req: Request, res: Response) => {
    const extendedReq = req as ExtendedRequest;
    const { toolId } = req.params;
    const { requestId, traceId } = getRequestIds(res);

    try {
      const tool = await service.getTool(toolId);

      if (!tool) {
        respondWithError(res, 404, {
          code: "not_found",
          message: "tool not found",
        });
        return;
      }

      res.json({ tool, requestId, traceId });

      logAuditEvent({
        action: "marketplace.tool.get",
        outcome: "success",
        subject: toAuditSubject(extendedReq.auth?.session),
        requestId,
        traceId,
        details: { toolId },
      });
    } catch (error) {
      logger.error({ err: error, toolId }, "failed to get tool");
      respondWithUnexpectedError(res, error);
    }
  });

  /**
   * PUT /marketplace/tools/:toolId
   * Update a tool version
   */
  router.put("/tools/:toolId", async (req: Request, res: Response) => {
    const extendedReq = req as ExtendedRequest;
    const session = requireAuth(extendedReq, res);
    if (!session) return;

    const { toolId } = req.params;
    const subject = toAuditSubject(session);
    const { requestId, traceId } = getRequestIds(res);

    // Policy check
    const policyDecision = await policy.enforceHttpAction({
      action: "http.put.marketplace.tools",
      requiredCapabilities: ["marketplace.publish"],
      traceId,
      subject: toPolicySubject(session),
      runMode,
    });

    if (!policyDecision.allow) {
      respondWithError(res, 403, {
        code: "forbidden",
        message: "marketplace update not allowed",
        details: policyDecision.deny,
      });
      logAuditEvent({
        action: "marketplace.tool.update",
        outcome: "denied",
        subject,
        requestId,
        traceId,
        details: { toolId, deny: policyDecision.deny },
      });
      return;
    }

    // Validate request
    const parsed = ToolVersionUpdateSchema.safeParse({ ...req.body, toolId });
    if (!parsed.success) {
      respondWithValidationError(
        res,
        formatValidationIssues(parsed.error.issues),
      );
      logAuditEvent({
        action: "marketplace.tool.update",
        outcome: "failure",
        subject,
        requestId,
        traceId,
        details: { toolId, reason: "invalid_request" },
      });
      return;
    }

    try {
      const update: ToolVersionUpdate = parsed.data;

      if (!session.tenantId) {
        res
          .status(403)
          .json({ error: "Tenant ID is required", requestId, traceId });
        return;
      }

      const listing = await service.updateToolVersion(update, {
        tenantId: session.tenantId,
        userId: session.subject,
      });

      res.json({ tool: listing, requestId, traceId });

      logAuditEvent({
        action: "marketplace.tool.update",
        outcome: "success",
        subject,
        requestId,
        traceId,
        details: { toolId, version: formatVersion(update.version) },
      });
    } catch (error) {
      logger.error({ err: error, toolId }, "failed to update tool");
      respondWithUnexpectedError(res, error);
      logAuditEvent({
        action: "marketplace.tool.update",
        outcome: "failure",
        subject,
        requestId,
        traceId,
        details: { toolId },
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * DELETE /marketplace/tools/:toolId
   * Delete a tool from marketplace
   */
  router.delete(
    "/tools/:toolId",
    async (req: Request, res: Response) => {
      const extendedReq = req as ExtendedRequest;
      const session = requireAuth(extendedReq, res);
      if (!session) return;

      const { toolId } = req.params;
      const subject = toAuditSubject(session);
      const { requestId, traceId } = getRequestIds(res);

      // Policy check
      const policyDecision = await policy.enforceHttpAction({
        action: "http.delete.marketplace.tools",
        requiredCapabilities: ["marketplace.manage"],
        traceId,
        subject: toPolicySubject(session),
        runMode,
      });

      if (!policyDecision.allow) {
        respondWithError(res, 403, {
          code: "forbidden",
          message: "marketplace deletion not allowed",
          details: policyDecision.deny,
        });
        logAuditEvent({
          action: "marketplace.tool.delete",
          outcome: "denied",
          subject,
          requestId,
          traceId,
          details: { toolId, deny: policyDecision.deny },
        });
        return;
      }

      try {
        if (!session.tenantId) {
          res
            .status(403)
            .json({ error: "Tenant ID is required", requestId, traceId });
          return;
        }

        const deleted = await service.deleteTool(toolId, {
          tenantId: session.tenantId,
          userId: session.subject,
        });

        if (!deleted) {
          respondWithError(res, 404, {
            code: "not_found",
            message: "tool not found",
          });
          return;
        }

        res.status(204).end();

        logAuditEvent({
          action: "marketplace.tool.delete",
          outcome: "success",
          subject,
          requestId,
          traceId,
          details: { toolId },
        });
      } catch (error) {
        logger.error({ err: error, toolId }, "failed to delete tool");
        respondWithUnexpectedError(res, error);
        logAuditEvent({
          action: "marketplace.tool.delete",
          outcome: "failure",
          subject,
          requestId,
          traceId,
          details: { toolId },
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  /**
   * POST /marketplace/tools/:toolId/archive
   * Archive a tool (soft delete)
   */
  router.post(
    "/tools/:toolId/archive",
    async (req: Request, res: Response) => {
      const extendedReq = req as ExtendedRequest;
      const session = requireAuth(extendedReq, res);
      if (!session) return;

      const { toolId } = req.params;
      const subject = toAuditSubject(session);
      const { requestId, traceId } = getRequestIds(res);

      try {
        if (!session.tenantId) {
          res
            .status(403)
            .json({ error: "Tenant ID is required", requestId, traceId });
          return;
        }

        const tool = await service.archiveTool(toolId, {
          tenantId: session.tenantId,
          userId: session.subject,
        });

        if (!tool) {
          respondWithError(res, 404, {
            code: "not_found",
            message: "tool not found",
          });
          return;
        }

        res.json({ tool, requestId, traceId });

        logAuditEvent({
          action: "marketplace.tool.archive",
          outcome: "success",
          subject,
          requestId,
          traceId,
          details: { toolId },
        });
      } catch (error) {
        logger.error({ err: error, toolId }, "failed to archive tool");
        respondWithUnexpectedError(res, error);
      }
    },
  );

  /**
   * POST /marketplace/tools/:toolId/deprecate
   * Deprecate a tool
   */
  router.post(
    "/tools/:toolId/deprecate",
    async (req: Request, res: Response) => {
      const extendedReq = req as ExtendedRequest;
      const session = requireAuth(extendedReq, res);
      if (!session) return;

      const { toolId } = req.params;
      const subject = toAuditSubject(session);
      const { requestId, traceId } = getRequestIds(res);

      try {
        if (!session.tenantId) {
          res
            .status(403)
            .json({ error: "Tenant ID is required", requestId, traceId });
          return;
        }

        const tool = await service.deprecateTool(toolId, {
          tenantId: session.tenantId,
          userId: session.subject,
        });

        if (!tool) {
          respondWithError(res, 404, {
            code: "not_found",
            message: "tool not found",
          });
          return;
        }

        res.json({ tool, requestId, traceId });

        logAuditEvent({
          action: "marketplace.tool.deprecate",
          outcome: "success",
          subject,
          requestId,
          traceId,
          details: { toolId },
        });
      } catch (error) {
        logger.error({ err: error, toolId }, "failed to deprecate tool");
        respondWithUnexpectedError(res, error);
      }
    },
  );

  /**
   * POST /marketplace/tools/:toolId/download
   * Record a tool download
   */
  router.post(
    "/tools/:toolId/download",
    async (req: Request, res: Response) => {
      const extendedReq = req as ExtendedRequest;
      const { toolId } = req.params;
      const { requestId, traceId } = getRequestIds(res);

      try {
        await service.recordDownload(toolId);
        res.status(204).end();

        logAuditEvent({
          action: "marketplace.tool.download",
          outcome: "success",
          subject: toAuditSubject(extendedReq.auth?.session),
          requestId,
          traceId,
          details: { toolId },
        });
      } catch (error) {
        logger.error({ err: error, toolId }, "failed to record download");
        respondWithUnexpectedError(res, error);
      }
    },
  );

  /**
   * POST /marketplace/tools/:toolId/reviews
   * Submit a tool review
   */
  router.post(
    "/tools/:toolId/reviews",
    async (req: Request, res: Response) => {
      const extendedReq = req as ExtendedRequest;
      const session = requireAuth(extendedReq, res);
      if (!session) return;

      const { toolId } = req.params;
      const subject = toAuditSubject(session);
      const { requestId, traceId } = getRequestIds(res);

      // Validate request
      const parsed = ToolReviewSchema.safeParse({ ...req.body, toolId });
      if (!parsed.success) {
        respondWithValidationError(
          res,
          formatValidationIssues(parsed.error.issues),
        );
        return;
      }

      try {
        const reviewData: ToolReview = parsed.data;
        const review = await service.submitReview(reviewData, {
          userId: session.subject,
          name: session.name ?? undefined,
        });

        res.status(201).json({ review, requestId, traceId });

        logAuditEvent({
          action: "marketplace.review.submit",
          outcome: "success",
          subject,
          requestId,
          traceId,
          details: { toolId, rating: review.rating },
        });
      } catch (error) {
        logger.error({ err: error, toolId }, "failed to submit review");
        respondWithUnexpectedError(res, error);
      }
    },
  );

  /**
   * GET /marketplace/tools/:toolId/reviews
   * Get tool reviews
   */
  router.get(
    "/tools/:toolId/reviews",
    async (req: Request, res: Response) => {
      const extendedReq = req as ExtendedRequest;
      const { toolId } = req.params;
      const { requestId, traceId } = getRequestIds(res);
      const limit = req.query.limit
        ? parseInt(req.query.limit as string, 10)
        : 20;
      const offset = req.query.offset
        ? parseInt(req.query.offset as string, 10)
        : 0;

      try {
        const reviews = await service.getReviews(toolId, limit, offset);

        res.json({ reviews, requestId, traceId });

        logAuditEvent({
          action: "marketplace.reviews.get",
          outcome: "success",
          subject: toAuditSubject(req.auth?.session),
          requestId,
          traceId,
          details: { toolId, count: reviews.length },
        });
      } catch (error) {
        logger.error({ err: error, toolId }, "failed to get reviews");
        respondWithUnexpectedError(res, error);
      }
    },
  );

  /**
   * GET /marketplace/featured
   * Get featured tools
   */
  router.get("/featured", async (req: ExtendedRequest, res: Response) => {
    const { requestId, traceId } = getRequestIds(res);
    const limit = req.query.limit
      ? parseInt(req.query.limit as string, 10)
      : 10;

    try {
      const tools = await service.getFeaturedTools(limit);
      res.json({ tools, requestId, traceId });
    } catch (error) {
      logger.error({ err: error }, "failed to get featured tools");
      respondWithUnexpectedError(res, error);
    }
  });

  /**
   * GET /marketplace/trending
   * Get trending tools
   */
  router.get("/trending", async (req: ExtendedRequest, res: Response) => {
    const { requestId, traceId } = getRequestIds(res);
    const limit = req.query.limit
      ? parseInt(req.query.limit as string, 10)
      : 10;

    try {
      const tools = await service.getTrendingTools(limit);
      res.json({ tools, requestId, traceId });
    } catch (error) {
      logger.error({ err: error }, "failed to get trending tools");
      respondWithUnexpectedError(res, error);
    }
  });

  /**
   * GET /marketplace/tools/:toolId/similar
   * Get similar tools
   */
  router.get(
    "/tools/:toolId/similar",
    async (req: ExtendedRequest, res: Response) => {
      const { toolId } = req.params;
      const { requestId, traceId } = getRequestIds(res);
      const limit = req.query.limit
        ? parseInt(req.query.limit as string, 10)
        : 5;

      try {
        const tools = await service.getSimilarTools(toolId, limit);
        res.json({ tools, requestId, traceId });
      } catch (error) {
        logger.error({ err: error, toolId }, "failed to get similar tools");
        respondWithUnexpectedError(res, error);
      }
    },
  );

  /**
   * GET /marketplace/my-tools
   * Get tools published by the authenticated user
   */
  router.get("/my-tools", async (req: ExtendedRequest, res: Response) => {
    const session = requireAuth(req, res);
    if (!session) return;

    const { requestId, traceId } = getRequestIds(res);

    try {
      if (!session.tenantId) {
        res
          .status(403)
          .json({ error: "Tenant ID is required", requestId, traceId });
        return;
      }

      const tools = await service.getPublisherTools(
        session.tenantId,
        session.subject,
      );
      res.json({ tools, requestId, traceId });

      logAuditEvent({
        action: "marketplace.my-tools.get",
        outcome: "success",
        subject: toAuditSubject(session),
        requestId,
        traceId,
        details: { count: tools.length },
      });
    } catch (error) {
      logger.error({ err: error }, "failed to get publisher tools");
      respondWithUnexpectedError(res, error);
    }
  });

  return router;
}
