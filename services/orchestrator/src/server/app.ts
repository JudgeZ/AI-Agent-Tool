import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { ServerResponse } from "node:http";

import cors, { type CorsOptions } from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";

import { loadConfig, type AppConfig } from "../config.js";
import { createPlan, type PlanSubject } from "../plan/index.js";
import {
  getPlanHistory,
  getLatestPlanStepEvent,
  subscribeToPlanSteps,
  type PlanStepEvent,
} from "../plan/events.js";
import {
  ChatRequestSchema,
  PlanApprovalSchema,
  PlanIdSchema,
  PlanRequestSchema,
  SecretKeySchema,
  SecretPromoteSchema,
  SecretRotateSchema,
  StepIdSchema,
  formatValidationIssues,
  type PlanApprovalPayload,
  type ChatRequestPayload,
} from "../http/validation.js";
import {
  createRequestIdentity,
  buildRateLimitBuckets,
  extractAgent,
  type RequestIdentity,
} from "../http/requestIdentity.js";
import { isTrustedProxyAddress } from "../http/clientIp.js";
import {
  respondWithError,
  respondWithUnexpectedError,
  respondWithValidationError,
} from "../http/errors.js";
import {
  getMetricsContentType,
  getMetricsSnapshot,
  recordRateLimitOutcome,
} from "../observability/metrics.js";
import { logAuditEvent, type AuditSubject } from "../observability/audit.js";
import {
  getRequestContext,
  runWithContext,
  type RequestContext,
  updateContextIdentifiers,
} from "../observability/requestContext.js";
import { appLogger, normalizeError } from "../observability/logger.js";
import {
  getPlanSubject,
  getPersistedPlanStep,
  resolvePlanStepApproval,
  submitPlanSteps,
} from "../queue/PlanQueueRuntime.js";
import { getPolicyEnforcer, type DenyReason } from "../policy/PolicyEnforcer.js";
import { SseQuotaManager } from "./SseQuotaManager.js";
import { sessionStore, type SessionRecord } from "../auth/SessionStore.js";
import { routeChat } from "../providers/ProviderRegistry.js";
import { getVersionedSecretsManager } from "../providers/ProviderRegistry.js";
import {
  authorize as oauthAuthorize,
  callback as oauthCallback,
} from "../auth/OAuthController.js";
import {
  getOidcConfiguration,
  handleOidcCallback,
  getSession as getOidcSession,
  logout as oidcLogout,
} from "../auth/OidcController.js";
import type { PlanStepState } from "../plan/validation.js";
import type { ApprovalDecision } from "../queue/PlanQueueRuntime.js";
import type { PlanStepEvent as StoredPlanStepEvent } from "../plan/events.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type ExtendedRequest = Request & {
  auth?: {
    session?: SessionRecord;
  };
};

type RateLimitResult = { allowed: true } | { allowed: false; retryAfterMs?: number };

class HttpRateLimiter {
  private readonly hits = new Map<string, number[]>();

  allow(key: string, windowMs: number, maxRequests: number): RateLimitResult {
    const now = Date.now();
    const windowStart = now - windowMs;
    const existing = this.hits.get(key) ?? [];
    const recent = existing.filter((timestamp) => timestamp > windowStart);
    if (recent.length >= maxRequests) {
      const oldest = Math.min(...recent);
      const retryAfter = Math.max(0, windowMs - (now - oldest));
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs: retryAfter };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true };
  }
}

function resolveConfig(config?: AppConfig): AppConfig {
  return config ?? loadConfig();
}

function toPlanSubject(session: SessionRecord): PlanSubject {
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

function toAuditSubject(session: SessionRecord | undefined): AuditSubject | undefined {
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

function subjectsMatch(owner: PlanSubject | undefined, candidate: PlanSubject | undefined): boolean {
  if (!owner) {
    return true;
  }
  if (!candidate) {
    return false;
  }
  if (owner.sessionId && candidate.sessionId && owner.sessionId === candidate.sessionId) {
    return true;
  }
  const tenantAligned = owner.tenantId ? owner.tenantId === candidate.tenantId : true;
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

function determineCorsOptions(config: AppConfig): CorsOptions {
  const allowedOrigins = new Set(
    (config.server.cors.allowedOrigins ?? []).map((origin) => origin.trim()).filter(Boolean),
  );

  return {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, allowedOrigins.has(origin));
    },
    credentials: true,
  };
}

function getRequestIds(res: Response): { requestId: string; traceId: string } {
  const context = getRequestContext();
  const requestId = context?.requestId ?? String(res.locals.requestId ?? randomUUID());
  const traceId = context?.traceId ?? String(res.locals.traceId ?? randomUUID());
  updateContextIdentifiers({ requestId, traceId });
  return { requestId, traceId };
}

function buildPolicyErrorMessage(deny: DenyReason[]): string {
  if (deny.length === 0) {
    return "policy denied";
  }
  const first = deny[0];
  if (first.capability) {
    return `${first.capability} denied`;
  }
  return first.reason ?? "policy denied";
}

function formatApprovalSummary(
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

async function waitForDrain(stream: ServerResponse): Promise<void> {
  if (stream.writableEnded || stream.destroyed) {
    return;
  }
  await once(stream, "drain");
}

function extractSessionId(req: Request, cookieName: string): string | undefined {
  const authHeader = req.header("authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token.length > 0) {
      return token;
    }
  }
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) {
    return undefined;
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
    const value = rest.join("=").trim();
    if (!value) {
      continue;
    }
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

function attachSession(req: ExtendedRequest, config: AppConfig): SessionRecord | undefined {
  const oidcConfig = config.auth.oidc;
  if (!oidcConfig.enabled) {
    return undefined;
  }
  sessionStore.cleanupExpired();
  const sessionId = extractSessionId(req, oidcConfig.session.cookieName);
  if (!sessionId) {
    return undefined;
  }
  const session = sessionStore.getSession(sessionId);
  if (session) {
    req.auth = { session };
  }
  return session;
}

async function enforceRateLimit(
  limiter: HttpRateLimiter,
  endpoint: string,
  identity: RequestIdentity,
  buckets: ReturnType<typeof buildRateLimitBuckets>,
): Promise<RateLimitResult> {
  for (const bucket of buckets) {
    const key = `${endpoint}:${bucket.identityType}:$${
      bucket.identityType === "identity"
        ? identity.subjectId ?? identity.agentName ?? identity.ip
        : identity.ip
    }`;
    const result = limiter.allow(key, bucket.windowMs, bucket.maxRequests);
    recordRateLimitOutcome(endpoint, bucket.identityType, result.allowed);
    if (!result.allowed) {
      return result;
    }
  }
  return { allowed: true };
}

function shouldStream(req: Request): boolean {
  const accept = req.headers.accept;
  if (!accept) {
    return false;
  }
  return accept.split(",").some((entry) => entry.trim().toLowerCase() === "text/event-stream");
}

function sanitizePlanEvent(event: PlanStepEvent): PlanStepEvent {
  const cloned: Mutable<PlanStepEvent> = { ...event, step: { ...event.step } };
  cloned.step.labels = [...(event.step.labels ?? [])];
  return cloned;
}

function setNoCacheHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
}

export function createServer(config?: AppConfig): Express {
  const appConfig = resolveConfig(config);
  const app = express();
  const policy = getPolicyEnforcer();
  const rateLimiter = new HttpRateLimiter();
  const quotaManager = new SseQuotaManager(appConfig.server.sseQuotas);

  if (appConfig.server.trustedProxyCidrs.length > 0) {
    app.set("trust proxy", (ip: string) =>
      isTrustedProxyAddress(ip, appConfig.server.trustedProxyCidrs),
    );
  }

  app.use((req: ExtendedRequest, res: Response, next: NextFunction) => {
    const headerRequestId = req.header("x-request-id")?.trim();
    const headerTraceId = req.header("x-trace-id")?.trim();
    const requestId = headerRequestId && headerRequestId.length > 0 ? headerRequestId : randomUUID();
    const traceId = headerTraceId && headerTraceId.length > 0 ? headerTraceId : randomUUID();
    res.locals.requestId = requestId;
    res.locals.traceId = traceId;
    res.setHeader("x-request-id", requestId);
    res.setHeader("x-trace-id", traceId);
    const context: RequestContext = { requestId, traceId };
    runWithContext(context, () => {
      return new Promise<void>((resolve) => {
        let completed = false;
        const complete = () => {
          if (completed) {
            return;
          }
          completed = true;
          res.off("finish", complete);
          res.off("close", complete);
          resolve();
        };

        res.once("finish", complete);
        res.once("close", complete);

        const wrappedNext: NextFunction = (err?: unknown) => {
          if (err !== undefined) {
            complete();
          }
          return next(err);
        };

        try {
          wrappedNext();
        } catch (error) {
          complete();
          throw error;
        }
      });
    });
  });

  app.use(cors(determineCorsOptions(appConfig)));
  app.use(express.json({ limit: appConfig.server.requestLimits.jsonBytes }));
  app.use(
    express.urlencoded({
      extended: true,
      limit: appConfig.server.requestLimits.urlEncodedBytes,
    }),
  );

  app.use((req: ExtendedRequest, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      const { requestId, traceId } = getRequestIds(res);
      appLogger.info(
        {
          event: "http.request",
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          durationMs: duration,
          requestId,
          traceId,
        },
        "handled http request",
      );
    });
    next();
  });

  app.use((req: ExtendedRequest, _res: Response, next: NextFunction) => {
    attachSession(req, appConfig);
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/readyz", (_req, res) => {
    const { requestId, traceId } = getRequestIds(res);
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
      requestId,
      traceId,
      details: {
        queue: { status: "ok" },
      },
    });
  });

  app.get("/metrics", async (_req, res) => {
    try {
      const snapshot = await getMetricsSnapshot();
      res.setHeader("Content-Type", getMetricsContentType());
      res.send(snapshot);
    } catch (error) {
      appLogger.error({ err: normalizeError(error) }, "failed to collect metrics");
      respondWithUnexpectedError(res, error);
    }
  });

  app.post("/plan", async (req: ExtendedRequest, res) => {
    const identity = createRequestIdentity(req, appConfig, req.auth?.session ? toPlanSubject(req.auth.session) : undefined);
    const rateLimitBuckets = buildRateLimitBuckets("plan", appConfig.server.rateLimits.plan);
    const rateDecision = await enforceRateLimit(rateLimiter, "plan", identity, rateLimitBuckets);
    if (!rateDecision.allowed) {
      respondWithError(res, 429, {
        code: "too_many_requests",
        message: "plan creation rate limit exceeded",
      }, rateDecision.retryAfterMs ? { retryAfterMs: rateDecision.retryAfterMs } : undefined);
      logAuditEvent({
        action: "plan.create",
        outcome: "denied",
        agent: identity.agentName,
        details: { reason: "rate_limited" },
        subject: toAuditSubject(req.auth?.session),
      });
      return;
    }

    const parsed = PlanRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      respondWithValidationError(res, formatValidationIssues(parsed.error.issues));
      logAuditEvent({
        action: "plan.create",
        outcome: "failure",
        agent: identity.agentName,
        subject: toAuditSubject(req.auth?.session),
        details: { reason: "invalid_request" },
      });
      return;
    }

    try {
      const plan = await createPlan(parsed.data.goal, {
        retentionDays: appConfig.retention.planArtifactsDays,
      });
      const { requestId, traceId } = getRequestIds(res);
      const subject = req.auth?.session ? toPlanSubject(req.auth.session) : undefined;
      if (subject) {
        await submitPlanSteps(plan, traceId, requestId, subject);
      } else {
        await submitPlanSteps(plan, traceId, requestId);
      }
      res.status(201).json({ plan, requestId, traceId });
      logAuditEvent({
        action: "plan.create",
        outcome: "success",
        agent: identity.agentName,
        requestId,
        traceId,
        subject: toAuditSubject(req.auth?.session),
        details: { planId: plan.id },
      });
    } catch (error) {
      appLogger.error({ err: normalizeError(error) }, "failed to create plan");
      respondWithUnexpectedError(res, error);
      logAuditEvent({
        action: "plan.create",
        outcome: "failure",
        agent: identity.agentName,
        subject: toAuditSubject(req.auth?.session),
        details: { reason: "exception" },
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/plan/:id/events", async (req: ExtendedRequest, res) => {
    const planIdResult = PlanIdSchema.safeParse(req.params.id);
    if (!planIdResult.success) {
      respondWithValidationError(res, formatValidationIssues(planIdResult.error.issues));
      return;
    }
    const planId = planIdResult.data;
    const wantsStream = shouldStream(req);
    const identity = createRequestIdentity(req, appConfig, req.auth?.session ? toPlanSubject(req.auth.session) : undefined);
    const rateDecision = await enforceRateLimit(
      rateLimiter,
      "plan-events",
      identity,
      buildRateLimitBuckets("plan-events", appConfig.server.rateLimits.plan),
    );
    if (!rateDecision.allowed) {
      respondWithError(res, 429, {
        code: "too_many_requests",
        message: wantsStream ? "too many concurrent event streams" : "plan events rate limit exceeded",
      }, rateDecision.retryAfterMs ? { retryAfterMs: rateDecision.retryAfterMs } : undefined);
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: wantsStream ? "plan.events.stream" : "plan.events.history",
        outcome: "denied",
        agent: identity.agentName,
        requestId,
        traceId,
        subject: toAuditSubject(req.auth?.session),
        details: { reason: "rate_limited", planId },
      });
      return;
    }

    const agent = identity.agentName;
    const owner = await getPlanSubject(planId);
    const requesterSubject = req.auth?.session ? toPlanSubject(req.auth.session) : undefined;

    const baseDecision = await policy.enforceHttpAction({
      action: "http.get.plan.events",
      requiredCapabilities: ["plan.read"],
      agent,
      traceId: getRequestContext()?.traceId,
      subject: toPolicySubject(req.auth?.session),
      runMode: appConfig.runMode,
    });
    if (!baseDecision.allow) {
      respondWithError(res, 403, {
        code: "forbidden",
        message: buildPolicyErrorMessage(baseDecision.deny),
        details: baseDecision.deny,
      });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "plan.events.access",
        outcome: "denied",
        agent,
        requestId,
        traceId,
        subject: toAuditSubject(req.auth?.session),
        details: { planId, deny: baseDecision.deny },
      });
      return;
    }

    if (owner && !subjectsMatch(owner, requesterSubject)) {
      respondWithError(res, 403, {
        code: "forbidden",
        message: wantsStream ? "subject does not match plan owner" : "subject does not match plan owner",
      });
      logAuditEvent({
        action: wantsStream ? "plan.events.stream" : "plan.events.history",
        outcome: "denied",
        agent,
        subject: toAuditSubject(req.auth?.session),
        details: { planId, reason: "subject_mismatch" },
      });
      return;
    }

    if (!wantsStream) {
      const historyDecision = await policy.enforceHttpAction({
        action: "http.get.plan.events.history",
        requiredCapabilities: ["plan.read"],
        agent,
        traceId: getRequestContext()?.traceId,
        subject: toPolicySubject(req.auth?.session),
        runMode: appConfig.runMode,
      });
      if (!historyDecision.allow) {
        respondWithError(res, 403, {
          code: "forbidden",
          message: buildPolicyErrorMessage(historyDecision.deny),
          details: historyDecision.deny,
        });
        const { requestId, traceId } = getRequestIds(res);
        logAuditEvent({
          action: "plan.events.history",
          outcome: "denied",
          agent,
          requestId,
          traceId,
          subject: toAuditSubject(req.auth?.session),
          details: { planId, deny: historyDecision.deny },
        });
        return;
      }
      setNoCacheHeaders(res);
      const events = getPlanHistory(planId).map(sanitizePlanEvent);
      const { requestId, traceId } = getRequestIds(res);
      res.json({ events, requestId, traceId });
      logAuditEvent({
        action: "plan.events.history",
        outcome: "success",
        agent,
        requestId,
        traceId,
        subject: toAuditSubject(req.auth?.session),
        details: { planId, events: events.length },
      });
      return;
    }

    const streamDecision = await policy.enforceHttpAction({
      action: "http.get.plan.events.stream",
      requiredCapabilities: ["plan.read"],
      agent,
      traceId: getRequestContext()?.traceId,
      subject: toPolicySubject(req.auth?.session),
      runMode: appConfig.runMode,
    });
    if (!streamDecision.allow) {
      respondWithError(res, 403, {
        code: "forbidden",
        message: buildPolicyErrorMessage(streamDecision.deny),
        details: streamDecision.deny,
      });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "plan.events.stream",
        outcome: "denied",
        agent,
        requestId,
        traceId,
        subject: toAuditSubject(req.auth?.session),
        details: { planId, deny: streamDecision.deny },
      });
      return;
    }

    const quotaRelease = quotaManager.acquire({
      ip: identity.ip,
      subjectId: requesterSubject?.sessionId ?? requesterSubject?.userId,
    });
    if (!quotaRelease) {
      respondWithError(res, 429, {
        code: "too_many_requests",
        message: "too many concurrent event streams",
      });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "plan.events.stream",
        outcome: "denied",
        agent,
        requestId,
        traceId,
        subject: toAuditSubject(req.auth?.session),
        details: { planId, reason: "quota_exhausted" },
      });
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const { requestId, traceId } = getRequestIds(res);
    logAuditEvent({
      action: "plan.events.stream",
      outcome: "success",
      agent,
      requestId,
      traceId,
      subject: toAuditSubject(req.auth?.session),
      details: { planId },
    });

    let closed = false;
    const releaseResources = () => {
      if (closed) {
        return;
      }
      closed = true;
      quotaRelease();
    };

    const responder = res as ServerResponse;
    let pending = Promise.resolve();
    const enqueue = (chunk: string) => {
      pending = pending
        .catch(() => undefined)
        .then(async () => {
          if (responder.writableEnded || responder.destroyed) {
            throw new Error("stream closed");
          }
          let written = false;
          try {
            written = responder.write(chunk);
          } catch (error) {
            throw error;
          }
          if (!written) {
            await waitForDrain(responder);
          }
        });
      pending.catch(() => releaseResources());
      return pending;
    };

    const keepAliveInterval = Math.max(1, appConfig.server.sseKeepAliveMs);
    const keepAlive = setInterval(() => {
      void enqueue(": keep-alive\n\n").catch(() => undefined);
    }, keepAliveInterval);
    keepAlive.unref?.();

    const history = getPlanHistory(planId).map(sanitizePlanEvent);
    try {
      for (const event of history) {
        await enqueue(`event: plan.step\n` + `data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      clearInterval(keepAlive);
      responder.destroy();
      releaseResources();
      appLogger.warn({ err: normalizeError(error) }, "failed to replay plan history");
      logAuditEvent({
        action: "plan.events.stream",
        outcome: "failure",
        agent,
        requestId,
        traceId,
        subject: toAuditSubject(req.auth?.session),
        error: error instanceof Error ? error.message : String(error),
        details: { planId, phase: "history_replay" },
      });
      return;
    }

    const unsubscribe = subscribeToPlanSteps(planId, (event: StoredPlanStepEvent) => {
      void enqueue(`event: plan.step\n` + `data: ${JSON.stringify(event)}\n\n`).catch(() => {
        unsubscribe();
        clearInterval(keepAlive);
        responder.destroy();
        releaseResources();
      });
    });

    const close = () => {
      unsubscribe();
      clearInterval(keepAlive);
      releaseResources();
    };

    req.on("close", close);
    res.on("close", close);
    res.on("finish", close);
  });

  const approvalHandler = async (
    req: ExtendedRequest,
    res: Response,
    overrideDecision: ApprovalDecision | undefined,
    actionName: string,
  ) => {
    const agent = extractAgent(req);
    const subjectForAudit = toAuditSubject(req.auth?.session);
    const rawPlanId = req.params.id;
    const rawStepId = req.params.stepId;
    const planIdResult = PlanIdSchema.safeParse(req.params.id);
    const stepIdResult = StepIdSchema.safeParse(req.params.stepId);
    if (!planIdResult.success || !stepIdResult.success) {
      const issues = [
        ...(planIdResult.success ? [] : planIdResult.error.issues),
        ...(stepIdResult.success ? [] : stepIdResult.error.issues),
      ];
      respondWithValidationError(res, formatValidationIssues(issues));
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: actionName,
        outcome: "failure",
        agent,
        subject: subjectForAudit,
        requestId,
        traceId,
        details: { reason: "invalid_params", planId: rawPlanId, stepId: rawStepId },
      });
      return;
    }
    const planId = planIdResult.data;
    const stepId = stepIdResult.data;

    if (appConfig.auth.oidc.enabled) {
      const session = req.auth?.session;
      if (!session) {
        respondWithError(res, 401, {
          code: "unauthorized",
          message: "authentication required",
        });
        const { requestId, traceId } = getRequestIds(res);
        logAuditEvent({
          action: actionName,
          outcome: "denied",
          agent,
          subject: subjectForAudit,
          requestId,
          traceId,
          details: { planId, stepId, reason: "authentication_required" },
        });
        return;
      }
    }

    const bodyResult = PlanApprovalSchema.safeParse(req.body ?? {});
    if (!bodyResult.success) {
      respondWithValidationError(res, formatValidationIssues(bodyResult.error.issues));
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: actionName,
        outcome: "failure",
        agent,
        subject: subjectForAudit,
        requestId,
        traceId,
        details: { planId, stepId, reason: "invalid_request" },
      });
      return;
    }
    const payload: PlanApprovalPayload = bodyResult.data;
    const decision = overrideDecision ?? payload.decision;

    const subject = req.auth?.session ? toPlanSubject(req.auth.session) : undefined;
    const owner = await getPlanSubject(planId);
    if (owner && !subjectsMatch(owner, subject)) {
      respondWithError(res, 403, {
        code: "forbidden",
        message: "approval subject mismatch",
      });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: actionName,
        outcome: "denied",
        agent,
        subject: subjectForAudit,
        requestId,
        traceId,
        details: { planId, stepId, reason: "subject_mismatch" },
      });
      return;
    }

    const policyDecision = await policy.enforceHttpAction({
      action: decision === "approved" ? "http.post.plan.steps.approve" : "http.post.plan.steps.reject",
      requiredCapabilities: ["plan.approve"],
      agent: extractAgent(req),
      traceId: getRequestContext()?.traceId,
      subject: toPolicySubject(req.auth?.session),
      runMode: appConfig.runMode,
    });
    if (!policyDecision.allow) {
      respondWithError(res, 403, {
        code: "forbidden",
        message: buildPolicyErrorMessage(policyDecision.deny),
        details: policyDecision.deny,
      });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: actionName,
        outcome: "denied",
        agent,
        subject: subjectForAudit,
        requestId,
        traceId,
        details: { planId, stepId, deny: policyDecision.deny },
      });
      return;
    }

    const historyEvent = getLatestPlanStepEvent(planId, stepId);
    let summary = historyEvent?.step.summary;
    let state: PlanStepState | undefined = historyEvent?.step.state;
    if (!historyEvent) {
      const persisted = await getPersistedPlanStep(planId, stepId);
      if (!persisted) {
        respondWithError(res, 404, {
          code: "not_found",
          message: "approval step not found",
        });
        const { requestId, traceId } = getRequestIds(res);
        logAuditEvent({
          action: actionName,
          outcome: "failure",
          agent,
          subject: subjectForAudit,
          requestId,
          traceId,
          details: { planId, stepId, reason: "step_not_found" },
        });
        return;
      }
      summary = persisted.summary ?? persisted.step?.summary;
      state = persisted.state;
    }

    if (state !== "waiting_approval") {
      respondWithError(res, 409, {
        code: "conflict",
        message: "step is not awaiting approval",
      });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: actionName,
        outcome: "failure",
        agent,
        subject: subjectForAudit,
        requestId,
        traceId,
        details: { planId, stepId, reason: "invalid_state", state },
      });
      return;
    }

    const finalSummary = formatApprovalSummary(decision, payload.rationale, summary);
    await resolvePlanStepApproval({
      planId,
      stepId,
      decision,
      summary: finalSummary,
    });
    const { requestId, traceId } = getRequestIds(res);
    logAuditEvent({
      action: actionName,
      outcome: decision === "approved" ? "approved" : "rejected",
      agent,
      subject: subjectForAudit,
      requestId,
      traceId,
      details: { planId, stepId, summary: finalSummary },
    });
    res.status(204).end();
  };

  app.post("/plan/:id/steps/:stepId/approve", async (req, res) => {
    const extended = req as ExtendedRequest;
    const actionName = "plan.step.approve";
    try {
      await approvalHandler(extended, res, undefined, actionName);
    } catch (error) {
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: actionName,
        outcome: "failure",
        agent: extractAgent(extended),
        subject: toAuditSubject(extended.auth?.session),
        requestId,
        traceId,
        details: { planId: extended.params.id, stepId: extended.params.stepId },
        error: error instanceof Error ? error.message : String(error),
      });
      respondWithUnexpectedError(res, error);
    }
  });

  app.post("/plan/:id/steps/:stepId/reject", async (req, res) => {
    const extended = req as ExtendedRequest;
    const actionName = "plan.step.reject";
    try {
      await approvalHandler(extended, res, "rejected", actionName);
    } catch (error) {
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: actionName,
        outcome: "failure",
        agent: extractAgent(extended),
        subject: toAuditSubject(extended.auth?.session),
        requestId,
        traceId,
        details: { planId: extended.params.id, stepId: extended.params.stepId },
        error: error instanceof Error ? error.message : String(error),
      });
      respondWithUnexpectedError(res, error);
    }
  });

  app.post("/chat", async (req, res) => {
    const identity = createRequestIdentity(req, appConfig, req.auth?.session ? toPlanSubject(req.auth.session) : undefined);
    const rateDecision = await enforceRateLimit(
      rateLimiter,
      "chat",
      identity,
      buildRateLimitBuckets("chat", appConfig.server.rateLimits.chat),
    );
    if (!rateDecision.allowed) {
      respondWithError(res, 429, {
        code: "too_many_requests",
        message: "chat rate limit exceeded",
      }, rateDecision.retryAfterMs ? { retryAfterMs: rateDecision.retryAfterMs } : undefined);
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "chat.route",
        outcome: "denied",
        agent: identity.agentName,
        subject: toAuditSubject(req.auth?.session),
        requestId,
        traceId,
        details: { reason: "rate_limited" },
      });
      return;
    }

    const parsed = ChatRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      respondWithValidationError(res, formatValidationIssues(parsed.error.issues));
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "chat.route",
        outcome: "failure",
        agent: identity.agentName,
        subject: toAuditSubject(req.auth?.session),
        requestId,
        traceId,
        details: { reason: "invalid_request" },
      });
      return;
    }

    try {
      const responsePayload = await routeChat(parsed.data as ChatRequestPayload);
      const { requestId, traceId } = getRequestIds(res);
      res.json({ response: responsePayload, requestId, traceId });
      logAuditEvent({
        action: "chat.route",
        outcome: "success",
        agent: identity.agentName,
        subject: toAuditSubject(req.auth?.session),
        requestId,
        traceId,
        details: {
          mode: parsed.data.mode,
          messageCount: Array.isArray(parsed.data.messages) ? parsed.data.messages.length : undefined,
        },
      });
    } catch (error) {
      respondWithUnexpectedError(res, error);
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "chat.route",
        outcome: "failure",
        agent: identity.agentName,
        subject: toAuditSubject(req.auth?.session),
        requestId,
        traceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/secrets/:key/rotate", async (req: ExtendedRequest, res) => {
    const agent = extractAgent(req);
    const subject = toAuditSubject(req.auth?.session);
    const keyResult = SecretKeySchema.safeParse(req.params.key);
    if (!keyResult.success) {
      respondWithValidationError(res, formatValidationIssues(keyResult.error.issues));
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "secrets.rotate",
        outcome: "failure",
        agent,
        subject,
        requestId,
        traceId,
        details: { reason: "invalid_key" },
      });
      return;
    }
    if (appConfig.auth.oidc.enabled && !req.auth?.session) {
      respondWithError(res, 401, {
        code: "unauthorized",
        message: "authentication required",
      });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "secrets.rotate",
        outcome: "denied",
        agent,
        subject,
        requestId,
        traceId,
        details: { key: keyResult.success ? keyResult.data : req.params.key, reason: "authentication_required" },
      });
      return;
    }
    const bodyResult = SecretRotateSchema.safeParse(req.body ?? {});
    if (!bodyResult.success) {
      respondWithValidationError(res, formatValidationIssues(bodyResult.error.issues));
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "secrets.rotate",
        outcome: "failure",
        agent,
        subject,
        requestId,
        traceId,
        details: { key: keyResult.data, reason: "invalid_request" },
      });
      return;
    }

    const policyDecision = await policy.enforceHttpAction({
      action: "http.post.secrets.rotate",
      requiredCapabilities: ["secrets.manage"],
      agent,
      traceId: getRequestContext()?.traceId,
      subject: toPolicySubject(req.auth?.session),
      runMode: appConfig.runMode,
    });
    if (!policyDecision.allow) {
      respondWithError(res, 403, {
        code: "forbidden",
        message: buildPolicyErrorMessage(policyDecision.deny),
        details: policyDecision.deny,
      });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "secrets.rotate",
        outcome: "denied",
        agent,
        subject,
        requestId,
        traceId,
        details: { key: keyResult.data, deny: policyDecision.deny },
      });
      return;
    }

    const manager = getVersionedSecretsManager();
    try {
      const version = await manager.rotate(keyResult.data, bodyResult.data.value, {
        retain: bodyResult.data.retain,
        labels: bodyResult.data.labels,
      });
      const { requestId, traceId } = getRequestIds(res);
      res.json({ version, requestId, traceId });
      logAuditEvent({
        action: "secrets.rotate",
        outcome: "success",
        agent,
        subject,
        requestId,
        traceId,
        details: { key: keyResult.data, versionId: version.id },
      });
    } catch (error) {
      respondWithUnexpectedError(res, error);
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "secrets.rotate",
        outcome: "failure",
        agent,
        subject,
        requestId,
        traceId,
        details: { key: keyResult.data },
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/secrets/:key/promote", async (req: ExtendedRequest, res) => {
    const agent = extractAgent(req);
    const subject = toAuditSubject(req.auth?.session);
    const keyResult = SecretKeySchema.safeParse(req.params.key);
    if (!keyResult.success) {
      respondWithValidationError(res, formatValidationIssues(keyResult.error.issues));
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "secrets.promote",
        outcome: "failure",
        agent,
        subject,
        requestId,
        traceId,
        details: { reason: "invalid_key" },
      });
      return;
    }
    if (appConfig.auth.oidc.enabled && !req.auth?.session) {
      respondWithError(res, 401, {
        code: "unauthorized",
        message: "authentication required",
      });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "secrets.promote",
        outcome: "denied",
        agent,
        subject,
        requestId,
        traceId,
        details: { key: keyResult.success ? keyResult.data : req.params.key, reason: "authentication_required" },
      });
      return;
    }
    const bodyResult = SecretPromoteSchema.safeParse(req.body ?? {});
    if (!bodyResult.success) {
      respondWithValidationError(res, formatValidationIssues(bodyResult.error.issues));
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "secrets.promote",
        outcome: "failure",
        agent,
        subject,
        requestId,
        traceId,
        details: { key: keyResult.data, reason: "invalid_request" },
      });
      return;
    }

    const policyDecision = await policy.enforceHttpAction({
      action: "http.post.secrets.promote",
      requiredCapabilities: ["secrets.manage"],
      agent,
      traceId: getRequestContext()?.traceId,
      subject: toPolicySubject(req.auth?.session),
      runMode: appConfig.runMode,
    });
    if (!policyDecision.allow) {
      respondWithError(res, 403, {
        code: "forbidden",
        message: buildPolicyErrorMessage(policyDecision.deny),
        details: policyDecision.deny,
      });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "secrets.promote",
        outcome: "denied",
        agent,
        subject,
        requestId,
        traceId,
        details: { key: keyResult.data, deny: policyDecision.deny },
      });
      return;
    }

    const manager = getVersionedSecretsManager();
    try {
      const version = await manager.promote(keyResult.data, bodyResult.data.versionId);
      const { requestId, traceId } = getRequestIds(res);
      res.json({ version, requestId, traceId });
      logAuditEvent({
        action: "secrets.promote",
        outcome: "success",
        agent,
        subject,
        requestId,
        traceId,
        details: { key: keyResult.data, versionId: version.id },
      });
    } catch (error) {
      respondWithUnexpectedError(res, error);
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "secrets.promote",
        outcome: "failure",
        agent,
        subject,
        requestId,
        traceId,
        details: { key: keyResult.data, versionId: bodyResult.success ? bodyResult.data.versionId : undefined },
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/secrets/:key/versions", async (req: ExtendedRequest, res) => {
    const agent = extractAgent(req);
    const subject = toAuditSubject(req.auth?.session);
    const keyResult = SecretKeySchema.safeParse(req.params.key);
    if (!keyResult.success) {
      respondWithValidationError(res, formatValidationIssues(keyResult.error.issues));
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "secrets.versions",
        outcome: "failure",
        agent,
        subject,
        requestId,
        traceId,
        details: { reason: "invalid_key" },
      });
      return;
    }
    if (appConfig.auth.oidc.enabled && !req.auth?.session) {
      respondWithError(res, 401, {
        code: "unauthorized",
        message: "authentication required",
      });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "secrets.versions",
        outcome: "denied",
        agent,
        subject,
        requestId,
        traceId,
        details: { key: keyResult.success ? keyResult.data : req.params.key, reason: "authentication_required" },
      });
      return;
    }

    const policyDecision = await policy.enforceHttpAction({
      action: "http.get.secrets.versions",
      requiredCapabilities: ["secrets.manage"],
      agent,
      traceId: getRequestContext()?.traceId,
      subject: toPolicySubject(req.auth?.session),
      runMode: appConfig.runMode,
    });
    if (!policyDecision.allow) {
      respondWithError(res, 403, {
        code: "forbidden",
        message: buildPolicyErrorMessage(policyDecision.deny),
        details: policyDecision.deny,
      });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "secrets.versions",
        outcome: "denied",
        agent,
        subject,
        requestId,
        traceId,
        details: { key: keyResult.data, deny: policyDecision.deny },
      });
      return;
    }

    const manager = getVersionedSecretsManager();
    try {
      const versions = await manager.listVersions(keyResult.data);
      const { requestId, traceId } = getRequestIds(res);
      res.json({ ...versions, requestId, traceId });
      logAuditEvent({
        action: "secrets.versions",
        outcome: "success",
        agent,
        subject,
        requestId,
        traceId,
        details: { key: keyResult.data, versions: versions.items?.length },
      });
    } catch (error) {
      respondWithUnexpectedError(res, error);
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "secrets.versions",
        outcome: "failure",
        agent,
        subject,
        requestId,
        traceId,
        details: { key: keyResult.data },
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/auth/oauth/:provider/authorize", oauthAuthorize);
  app.post("/auth/oauth/:provider/callback", oauthCallback);

  app.get("/auth/oidc/config", getOidcConfiguration);
  app.post("/auth/oidc/callback", handleOidcCallback);
  app.get("/auth/session", getOidcSession);
  app.delete("/auth/session", oidcLogout);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    appLogger.error({ err: normalizeError(err) }, "unhandled error");
    respondWithUnexpectedError(res, err);
  });

  return app;
}

