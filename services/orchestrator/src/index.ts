import fs from "node:fs";
import http from "node:http";
import https from "node:https";

import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import { createPlan } from "./plan/planner.js";
import {
  getLatestPlanStepEvent,
  getPlanHistory,
  publishPlanStepEvent,
  subscribeToPlanSteps,
  type PlanStepEvent,
} from "./plan/events.js";
import { routeChat } from "./providers/ProviderRegistry.js";
import { ensureTracing, withSpan } from "./observability/tracing.js";
import {
  initializePlanQueueRuntime,
  getPlanSubject,
  resolvePlanStepApproval,
  submitPlanSteps,
  type ApprovalDecision,
} from "./queue/PlanQueueRuntime.js";
import {
  authorize as oauthAuthorize,
  callback as oauthCallback,
} from "./auth/OAuthController.js";
import {
  getOidcConfiguration,
  handleOidcCallback,
  getSession as getOidcSession,
  logout as logoutSession,
} from "./auth/OidcController.js";
import { sessionStore } from "./auth/SessionStore.js";
import { loadConfig, type AppConfig } from "./config.js";
import {
  getPolicyEnforcer,
  PolicyViolationError,
  type PolicyDecision,
} from "./policy/PolicyEnforcer.js";
import {
  getMetricsContentType,
  getMetricsSnapshot,
} from "./observability/metrics.js";
import {
  logAuditEvent,
  type AuditOutcome,
  type AuditSubject,
} from "./observability/audit.js";
import { SseQuotaManager } from "./server/SseQuotaManager.js";
import { resolveClientIp } from "./http/clientIp.js";
import {
  ChatRequestSchema,
  PlanApprovalSchema,
  PlanIdSchema,
  PlanRequestSchema,
  StepIdSchema,
  formatValidationIssues,
  type PlanApprovalPayload,
} from "./http/validation.js";

function formatSse(event: PlanStepEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
}

const GENERIC_ERROR_MESSAGE = "internal server error";
const TOO_MANY_EVENT_STREAMS_MESSAGE = "too many concurrent event streams";

function sendValidationError(
  res: Response,
  issues: Array<{ path: string; message: string }>,
): void {
  res.status(400).json({ error: "invalid request", details: issues });
}

function extractAgent(req: Request): string | undefined {
  const headerAgent = req.header("x-agent");
  if (typeof headerAgent === "string" && headerAgent.trim().length > 0) {
    return headerAgent.trim();
  }
  const bodyAgent =
    req.body && typeof req.body.agent === "string"
      ? req.body.agent.trim()
      : undefined;
  return bodyAgent && bodyAgent.length > 0 ? bodyAgent : undefined;
}

type AuthorizationContext = {
  subject?: RequestSubjectContext;
  agent?: string;
  traceId?: string;
  resource?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
};

function toAuditSubject(
  subject: RequestSubjectContext | undefined,
): AuditSubject | undefined {
  if (!subject) {
    return undefined;
  }
  return {
    sessionId: subject.sessionId,
    userId: subject.user.id,
    tenantId: subject.tenant,
    email: subject.user.email ?? null,
    name: subject.user.name ?? null,
    roles: subject.roles.length > 0 ? [...subject.roles] : undefined,
    scopes: subject.scopes.length > 0 ? [...subject.scopes] : undefined,
  };
}

function ensureAllowed(
  action: string,
  decision: PolicyDecision,
  context?: AuthorizationContext,
): void {
  if (!decision.allow) {
    const violation = new PolicyViolationError(
      `${action} denied by capability policy`,
      decision.deny,
    );
    logPolicyViolation(action, violation, context);
    throw violation;
  }
}

function logPolicyViolation(
  action: string,
  error: PolicyViolationError,
  context?: AuthorizationContext,
): void {
  logAuditEvent({
    action,
    outcome: "denied",
    traceId: context?.traceId,
    requestId: context?.requestId,
    agent: context?.agent,
    resource: context?.resource,
    subject: toAuditSubject(context?.subject),
    details: context?.metadata
      ? { ...context.metadata, deny: error.details, error: error.message }
      : { deny: error.details, error: error.message },
  });
}

function extractSessionIdFromRequest(
  req: Request,
  cookieName: string,
): string | undefined {
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
    if (rawName.trim() !== cookieName) {
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

type RequestSubjectContext = {
  tenant?: string;
  roles: string[];
  scopes: string[];
  sessionId: string;
  user: {
    id: string;
    email?: string;
    name?: string;
  };
};

export type RequestIdentity = {
  subjectId?: string;
  agentName?: string;
  ip: string;
};

export function createRequestIdentity(
  req: Request,
  config: AppConfig,
  subject?: RequestSubjectContext,
): RequestIdentity {
  const resolvedSubject = subject ?? resolveRequestSubject(req, config);
  const agentName = resolvedSubject ? extractAgent(req) : undefined;
  return {
    subjectId: resolvedSubject?.sessionId,
    agentName,
    ip: resolveClientIp(req, config.server.trustedProxyCidrs),
  };
}

export function buildRateLimitKey(identity: RequestIdentity): string {
  if (identity.subjectId) {
    return `subject:${identity.subjectId}`;
  }
  return `ip:${identity.ip}`;
}

function resolveRequestSubject(
  req: Request,
  config: AppConfig,
): RequestSubjectContext | undefined {
  if (!config.auth.oidc.enabled) {
    return undefined;
  }
  const cookieName = config.auth.oidc.session.cookieName;
  const sessionId = extractSessionIdFromRequest(req, cookieName);
  if (!sessionId) {
    return undefined;
  }
  sessionStore.cleanupExpired();
  const session = sessionStore.getSession(sessionId);
  if (!session) {
    return undefined;
  }
  return {
    tenant: session.tenantId ?? undefined,
    roles: [...session.roles],
    scopes: [...session.scopes],
    sessionId,
    user: {
      id: session.subject,
      email: session.email ?? undefined,
      name: session.name ?? undefined,
    },
  };
}

function toPolicySubject(subject: RequestSubjectContext | undefined) {
  if (!subject) {
    return undefined;
  }
  return {
    tenant: subject.tenant,
    roles: subject.roles,
    scopes: subject.scopes,
    sessionId: subject.sessionId,
    user: {
      id: subject.user.id,
      email: subject.user.email,
      name: subject.user.name,
    },
  };
}

function toPlanSubject(subject: RequestSubjectContext | undefined) {
  if (!subject) {
    return undefined;
  }
  return {
    sessionId: subject.sessionId,
    tenantId: subject.tenant,
    userId: subject.user.id,
    email: subject.user.email,
    name: subject.user.name,
    roles: [...subject.roles],
    scopes: [...subject.scopes],
  };
}

export function createServer(appConfig?: AppConfig): Express {
  const config = appConfig ?? loadConfig();
  void ensureTracing(config.observability.tracing).catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Failed to configure tracing", error);
  });
  const app = express();
  const policy = getPolicyEnforcer();
  const sseQuotaManager = new SseQuotaManager(config.server.sseQuotas);

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(morgan("dev"));

  const planLimiter = rateLimit({
    windowMs: config.server.rateLimits.plan.windowMs,
    limit: config.server.rateLimits.plan.maxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => buildRateLimitKey(createRequestIdentity(req, config)),
  });
  const chatLimiter = rateLimit({
    windowMs: config.server.rateLimits.chat.windowMs,
    limit: config.server.rateLimits.chat.maxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => buildRateLimitKey(createRequestIdentity(req, config)),
  });
  const authLimiter = rateLimit({
    windowMs: config.server.rateLimits.auth.windowMs,
    limit: config.server.rateLimits.auth.maxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => buildRateLimitKey(createRequestIdentity(req, config)),
  });

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  app.get(
    "/metrics",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const metrics = await getMetricsSnapshot();
        res.setHeader("Content-Type", getMetricsContentType());
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.status(200).send(metrics);
      } catch (error) {
        next(error);
      }
    },
  );

  app.use("/auth", authLimiter);

  app.get("/auth/oidc/config", getOidcConfiguration);
  app.post("/auth/oidc/callback", handleOidcCallback);
  app.get("/auth/session", getOidcSession);
  app.post("/auth/logout", logoutSession);

  app.get("/auth/:provider/authorize", oauthAuthorize);
  app.post("/auth/:provider/callback", oauthCallback);

  app.post(
    "/plan",
    planLimiter,
    async (req: Request, res: Response, next: NextFunction) => {
      const parsedBody = PlanRequestSchema.safeParse(req.body ?? {});
      if (!parsedBody.success) {
        sendValidationError(
          res,
          formatValidationIssues(parsedBody.error.issues),
        );
        return;
      }
      const { goal } = parsedBody.data;

      try {
        const requestSubject = resolveRequestSubject(req, config);
        const agentName = extractAgent(req);
        const requestId = req.header("x-request-id") ?? undefined;
        const result = await withSpan(
          "http.post.plan",
          async (span) => {
            const authorizationContext: AuthorizationContext = {
              agent: agentName,
              subject: requestSubject,
              traceId: span.context.traceId,
              requestId,
              resource: "plan",
              metadata: { route: "/plan", method: req.method },
            };
            let decision: PolicyDecision;
            try {
              decision = await policy.enforceHttpAction({
                action: "http.post.plan",
                requiredCapabilities: ["plan.create"],
                agent: agentName,
                traceId: span.context.traceId,
                subject: toPolicySubject(requestSubject),
              });
            } catch (error) {
              if (error instanceof PolicyViolationError) {
                logPolicyViolation("plan.create", error, authorizationContext);
              }
              throw error;
            }
            ensureAllowed("plan.create", decision, authorizationContext);
            const plan = await createPlan(goal, {
              retentionDays: config.retention.planArtifactsDays,
            });
            span.setAttribute("plan.id", plan.id);
            span.setAttribute("plan.id_length", plan.id.length);
            span.setAttribute("plan.steps", plan.steps.length);
            const planSubject = toPlanSubject(requestSubject);
            if (planSubject) {
              await submitPlanSteps(plan, span.context.traceId, planSubject);
            } else {
              await submitPlanSteps(plan, span.context.traceId);
            }
            logAuditEvent({
              action: "plan.create",
              outcome: "success",
              traceId: span.context.traceId,
              requestId,
              agent: agentName,
              resource: "plan",
              subject: toAuditSubject(requestSubject),
              details: { planId: plan.id, steps: plan.steps.length },
            });
            return { plan, traceId: span.context.traceId };
          },
          { route: "/plan" },
        );
        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/plan/:id/events",
    async (req: Request, res: Response, next: NextFunction) => {
      const planIdResult = PlanIdSchema.safeParse(req.params.id);
      if (!planIdResult.success) {
        const message =
          planIdResult.error.issues[0]?.message ?? "plan id is invalid";
        sendValidationError(res, [{ path: "id", message }]);
        return;
      }
      const planId = planIdResult.data;
      const acceptsSse = req.headers.accept?.includes("text/event-stream");
      const agentName = extractAgent(req);
      const requestId = req.header("x-request-id") ?? undefined;
      let authorization: {
        requestSubject?: RequestSubjectContext;
      } | undefined;
      try {
        authorization = await withSpan(
          "http.get.plan.events",
          async (span) => {
            const requestSubject = resolveRequestSubject(req, config);
            const authorizationContext: AuthorizationContext = {
              agent: agentName,
              subject: requestSubject,
              traceId: span.context.traceId,
              requestId,
              resource: "plan.events",
              metadata: {
                route: "/plan/:id/events",
                method: req.method,
                planId,
              },
            };
            let decision: PolicyDecision;
            try {
              decision = await policy.enforceHttpAction({
                action: "http.get.plan.events",
                requiredCapabilities: ["plan.read"],
                agent: agentName,
                traceId: span.context.traceId,
                subject: toPolicySubject(requestSubject),
              });
            } catch (error) {
              if (error instanceof PolicyViolationError) {
                logPolicyViolation("plan.read", error, authorizationContext);
              }
              throw error;
            }
            ensureAllowed("plan.read", decision, authorizationContext);
            const storedSubject = await getPlanSubject(planId);
            if (storedSubject) {
              const tenantMatches =
                storedSubject.tenantId === undefined ||
                (requestSubject?.tenant !== undefined &&
                  storedSubject.tenantId === requestSubject.tenant);
              const matches =
                !!requestSubject &&
                storedSubject.userId === requestSubject.user.id &&
                tenantMatches;
              if (!matches) {
                logAuditEvent({
                  action: "plan.read",
                  outcome: "denied",
                  traceId: span.context.traceId,
                  requestId,
                  agent: agentName,
                  resource: "plan.events",
                  subject: toAuditSubject(requestSubject),
                  details: {
                    planId,
                    reason: "subject_mismatch",
                    storedSessionId: storedSubject.sessionId,
                    storedUserId: storedSubject.userId,
                    storedTenantId: storedSubject.tenantId,
                    requestTenantId: requestSubject?.tenant,
                  },
                });
                throw new PolicyViolationError(
                  "plan.read denied: subject does not match plan owner",
                  [
                    {
                      reason: "subject_mismatch",
                      capability: "plan.read",
                    },
                  ],
                );
              }
            }
            return { requestSubject };
          },
          { route: "/plan/:id/events", planId },
        );
      } catch (error) {
        next(error);
        return;
      }

      const requestSubject = authorization?.requestSubject;

      if (acceptsSse) {
        try {
          await withSpan(
            "http.get.plan.events.stream",
            async (span) => {
              const authorizationContext: AuthorizationContext = {
                agent: agentName,
                subject: requestSubject,
                traceId: span.context.traceId,
                requestId,
                resource: "plan.events",
                metadata: {
                  route: "/plan/:id/events",
                  method: req.method,
                  planId,
                  responseType: "sse",
                },
              };
              let decision: PolicyDecision;
              try {
                decision = await policy.enforceHttpAction({
                  action: "http.get.plan.events.stream",
                  requiredCapabilities: ["plan.read"],
                  agent: agentName,
                  traceId: span.context.traceId,
                  subject: toPolicySubject(requestSubject),
                });
              } catch (error) {
                if (error instanceof PolicyViolationError) {
                  logPolicyViolation("plan.read", error, authorizationContext);
                }
                throw error;
              }
              ensureAllowed("plan.read", decision, authorizationContext);
            },
            { route: "/plan/:id/events", planId, responseType: "sse" },
          );
        } catch (error) {
          next(error);
          return;
        }
        const identity = createRequestIdentity(req, config, requestSubject);
        const releaseHandle = sseQuotaManager.acquire({
          ip: identity.ip,
          subjectId: identity.subjectId,
        });
        if (!releaseHandle) {
          res
            .status(429)
            .json({ error: TOO_MANY_EVENT_STREAMS_MESSAGE });
          return;
        }
        let released = false;
        const releaseQuota = () => {
          if (released) {
            return;
          }
          released = true;
          releaseHandle();
        };

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      let replayingHistory = true;
      const buffered: PlanStepEvent[] = [];
      let keepAlive: NodeJS.Timeout | undefined;
      let cleanedUp = false;
      let unsubscribe: () => void = () => {};

      const cleanup = () => {
        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        if (keepAlive) {
          clearInterval(keepAlive);
          keepAlive = undefined;
        }
        unsubscribe();
        releaseQuota();
        if (!res.writableEnded) {
          try {
            res.end();
          } catch {
            // ignore errors while ending the response during cleanup
          }
        }
      };

      const writeEvent = (event: PlanStepEvent): boolean => {
        if (cleanedUp) {
          return false;
        }
        try {
          const ok = res.write(formatSse(event));
          if (!ok) {
            cleanup();
            return false;
          }
          return true;
        } catch {
          cleanup();
          return false;
        }
      };

      unsubscribe = subscribeToPlanSteps(planId, (event) => {
        if (replayingHistory) {
          buffered.push(event);
          return;
        }
        writeEvent(event);
      });

      const history = getPlanHistory(planId);
      for (const event of history) {
        if (!writeEvent(event)) {
          return;
        }
      }

      replayingHistory = false;
      const bufferedEvents = buffered.splice(0);
      for (const event of bufferedEvents) {
        if (!writeEvent(event)) {
          return;
        }
      }

      const keepAliveInterval = config.server.sseKeepAliveMs;
      const sendKeepAlive = () => {
        if (cleanedUp) {
          cleanup();
          return;
        }
        try {
          const ok = res.write(": keep-alive\n\n");
          if (!ok) {
            cleanup();
          }
        } catch {
          cleanup();
        }
      };
      keepAlive = setInterval(sendKeepAlive, keepAliveInterval);

      req.on("close", () => {
        cleanup();
      });
    } else {
      try {
        await withSpan(
          "http.get.plan.events.history",
          async (span) => {
            const authorizationContext: AuthorizationContext = {
              agent: agentName,
              subject: requestSubject,
              traceId: span.context.traceId,
              requestId,
              resource: "plan.events",
              metadata: {
                route: "/plan/:id/events",
                method: req.method,
                planId,
                responseType: "json",
              },
            };
            let decision: PolicyDecision;
            try {
              decision = await policy.enforceHttpAction({
                action: "http.get.plan.events.history",
                requiredCapabilities: ["plan.read"],
                agent: agentName,
                traceId: span.context.traceId,
                subject: toPolicySubject(requestSubject),
              });
            } catch (error) {
              if (error instanceof PolicyViolationError) {
                logPolicyViolation("plan.read", error, authorizationContext);
              }
              throw error;
            }
            ensureAllowed("plan.read", decision, authorizationContext);
          },
          { route: "/plan/:id/events", planId, responseType: "json" },
        );
      } catch (error) {
        next(error);
        return;
      }
      const events = getPlanHistory(planId);
      res.json({ events });
    }
    },
  );

  app.post(
    "/plan/:planId/steps/:stepId/approve",
    planLimiter,
    async (req: Request, res: Response, next: NextFunction) => {
      const planIdResult = PlanIdSchema.safeParse(req.params.planId);
      if (!planIdResult.success) {
        const message =
          planIdResult.error.issues[0]?.message ?? "plan id is invalid";
        sendValidationError(res, [{ path: "planId", message }]);
        return;
      }
      const stepIdResult = StepIdSchema.safeParse(req.params.stepId);
      if (!stepIdResult.success) {
        const message =
          stepIdResult.error.issues[0]?.message ?? "step id is invalid";
        sendValidationError(res, [{ path: "stepId", message }]);
        return;
      }
      const approvalResult = PlanApprovalSchema.safeParse(req.body ?? {});
      if (!approvalResult.success) {
        sendValidationError(
          res,
          formatValidationIssues(approvalResult.error.issues),
        );
        return;
      }
      const planId = planIdResult.data;
      const stepId = stepIdResult.data;
      const approval = approvalResult.data as PlanApprovalPayload;
      const decision: ApprovalDecision =
        approval.decision === "rejected" ? "rejected" : "approved";
      const rationale = approval.rationale;
      const auditOutcome: AuditOutcome = decision;

      const latest = getLatestPlanStepEvent(planId, stepId);
      if (!latest) {
        res.status(404).json({ error: "Step not found" });
        return;
      }

      if (latest.step.state !== "waiting_approval") {
        res.status(409).json({ error: "Step is not awaiting approval" });
        return;
      }

      const decoratedDecision = rationale
        ? `${decision}: ${rationale}`
        : decision;
      const summary = rationale
        ? `${latest.step.summary ?? ""}${
            latest.step.summary ? " " : ""
          }(${decoratedDecision})`
        : latest.step.summary;

      const requestSubject = resolveRequestSubject(req, config);
      const agentName = extractAgent(req);
      const requestId = req.header("x-request-id") ?? undefined;

      if (config.auth.oidc.enabled && !requestSubject) {
        logAuditEvent({
          action: "plan.step.approval",
          outcome: "denied",
          traceId: latest.traceId,
          requestId,
          agent: agentName,
          resource: "plan.step",
          details: { planId, stepId, reason: "missing_session" },
        });
        res
          .status(401)
          .json({
            error: "authentication required",
          });
        return;
      }

      try {
        const planSubject = await getPlanSubject(planId);
        let sessionReauthenticated = false;
        if (config.auth.oidc.enabled) {
          if (!planSubject || !requestSubject) {
            logAuditEvent({
              action: "plan.step.approval",
              outcome: "denied",
              traceId: latest.traceId,
              requestId,
              agent: agentName,
              resource: "plan.step",
              details: { planId, stepId, reason: "missing_plan_subject" },
            });
            res.status(403).json({ error: "approval subject mismatch" });
            return;
          }

          const tenantMatches =
            (planSubject.tenantId ?? undefined) === (requestSubject.tenant ?? undefined);
          const userMatches =
            typeof planSubject.userId === "string" &&
            planSubject.userId === requestSubject.user.id;
          sessionReauthenticated =
            typeof planSubject.sessionId === "string" &&
            planSubject.sessionId.length > 0 &&
            (!requestSubject.sessionId ||
              planSubject.sessionId !== requestSubject.sessionId);
          let mismatchReason: "tenant_mismatch" | "user_mismatch" | undefined;
          if (!tenantMatches) {
            mismatchReason = "tenant_mismatch";
          } else if (!userMatches) {
            mismatchReason = "user_mismatch";
          }
          if (mismatchReason) {
            logAuditEvent({
              action: "plan.step.approval",
              outcome: "denied",
              traceId: latest.traceId,
              requestId,
              agent: agentName,
              resource: "plan.step",
              subject: toAuditSubject(requestSubject),
              details: {
                planId,
                stepId,
                reason: mismatchReason,
              },
            });
            res.status(403).json({ error: "approval subject mismatch" });
            return;
          }
        }

        const authorizationContext: AuthorizationContext = {
          agent: agentName,
          subject: requestSubject,
          traceId: latest.traceId,
          requestId,
          resource: "plan.step",
          metadata: { planId, stepId },
        };
        let decisionResult: PolicyDecision;
        try {
          decisionResult = await policy.enforceHttpAction({
            action: "http.post.plan.approve",
            requiredCapabilities: ["plan.approve"],
            agent: agentName,
            traceId: latest.traceId,
            subject: toPolicySubject(requestSubject),
          });
        } catch (error) {
          if (error instanceof PolicyViolationError) {
            logPolicyViolation("plan.approve", error, authorizationContext);
          }
          throw error;
        }
        ensureAllowed("plan.approve", decisionResult, authorizationContext);
        await resolvePlanStepApproval({ planId, stepId, decision, summary });
        logAuditEvent({
          action: "plan.step.approval",
          outcome: auditOutcome,
          traceId: latest.traceId,
          requestId,
          agent: agentName,
          resource: "plan.step",
          subject: toAuditSubject(requestSubject),
          details: {
            planId,
            stepId,
            summary,
            ...(sessionReauthenticated ? { sessionReauthenticated: true } : {}),
            ...(rationale ? { rationale } : {}),
          },
        });
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/chat",
    chatLimiter,
    async (req: Request, res: Response, next: NextFunction) => {
      const parsedBody = ChatRequestSchema.safeParse(req.body ?? {});
      if (!parsedBody.success) {
        sendValidationError(
          res,
          formatValidationIssues(parsedBody.error.issues),
        );
        return;
      }
      const { messages, model } = parsedBody.data;

      try {
        const requestSubject = resolveRequestSubject(req, config);
        const agentName = extractAgent(req);
        const requestId = req.header("x-request-id") ?? undefined;
        const result = await withSpan(
          "http.post.chat",
          async (span) => {
            const authorizationContext: AuthorizationContext = {
              agent: agentName,
              subject: requestSubject,
              traceId: span.context.traceId,
              requestId,
              resource: "chat",
              metadata: {
                model: typeof model === "string" ? model : undefined,
                messageCount: messages.length,
              },
            };
            let decisionResult: PolicyDecision;
            try {
              decisionResult = await policy.enforceHttpAction({
                action: "http.post.chat",
                requiredCapabilities: ["chat.invoke"],
                agent: agentName,
                traceId: span.context.traceId,
                subject: toPolicySubject(requestSubject),
              });
            } catch (error) {
              if (error instanceof PolicyViolationError) {
                logPolicyViolation("chat.invoke", error, authorizationContext);
              }
              throw error;
            }
            ensureAllowed("chat.invoke", decisionResult, authorizationContext);
            span.setAttribute("chat.message_count", messages.length);
            if (typeof model === "string") {
              span.setAttribute("chat.model", model);
            }
            const response = await routeChat({
              messages,
              model,
            });
            logAuditEvent({
              action: "chat.invoke",
              outcome: "success",
              traceId: span.context.traceId,
              requestId,
              agent: agentName,
              resource: "chat",
              subject: toAuditSubject(requestSubject),
              details: {
                model: typeof model === "string" ? model : undefined,
                messageCount: messages.length,
              },
            });
            return {
              traceId: span.context.traceId,
              response,
            };
          },
          { route: "/chat" },
        );
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const error = err instanceof Error ? err : new Error(String(err));
    // eslint-disable-next-line no-console
    console.error("Unhandled error", error);
    if (error instanceof PolicyViolationError) {
      if (!res.headersSent) {
        res
          .status(error.status)
          .json({ error: error.message, details: error.details });
      }
      return;
    }
    if (!res.headersSent) {
      res.status(500).json({ error: GENERIC_ERROR_MESSAGE });
    }
  });

  return app;
}

export function createHttpServer(
  app: Express,
  config: AppConfig,
): http.Server | https.Server {
  if (config.server.tls.enabled) {
    const { keyPath, certPath, caPaths, requestClientCert } = config.server.tls;
    if (!keyPath || !certPath) {
      throw new Error("TLS is enabled but keyPath or certPath is undefined");
    }
    const options: https.ServerOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
      requestCert: requestClientCert,
      rejectUnauthorized: requestClientCert,
    };
    if (caPaths.length > 0) {
      options.ca = caPaths.map((caPath) => fs.readFileSync(caPath));
    }
    return https.createServer(options, app);
  }
  return http.createServer(app);
}

if (process.env.NODE_ENV !== "test") {
  bootstrapOrchestrator().catch((error) => {
    // eslint-disable-next-line no-console
    console.error("orchestrator startup failed", error);
    process.exit(1);
  });
}

export async function bootstrapOrchestrator(
  appConfig?: AppConfig,
): Promise<http.Server | https.Server> {
  const port = Number(process.env.PORT) || 4000;
  const config = appConfig ?? loadConfig();
  try {
    await initializePlanQueueRuntime();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Failed to initialize queue runtime", error);
    throw error;
  }
  const app = createServer(config);
  const server = createHttpServer(app, config);
  server.listen(port, () => {
    const protocol = config.server.tls.enabled ? "https" : "http";
    // eslint-disable-next-line no-console
    console.info(`orchestrator listening on ${protocol}://localhost:${port}`);
  });
  return server;
}
