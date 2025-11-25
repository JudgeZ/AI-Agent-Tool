import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { Response } from "express";

import { createPlan } from "../plan/index.js";
import {
  getPlanHistory,
  getLatestPlanStepEvent,
  subscribeToPlanSteps,
  type PlanStepEvent as StoredPlanStepEvent,
} from "../plan/events.js";
import {
  PlanApprovalSchema,
  PlanIdSchema,
  PlanRequestSchema,
  StepIdSchema,
  formatValidationIssues,
  type PlanApprovalPayload,
} from "../http/validation.js";
import {
  createRequestIdentity,
  buildRateLimitBuckets,
  extractAgent,
} from "../http/requestIdentity.js";
import { respondWithError, respondWithUnexpectedError, respondWithValidationError } from "../http/errors.js";
import { logAuditEvent } from "../observability/audit.js";
import { getRequestContext } from "../observability/requestContext.js";
import {
  getPlanSubject,
  getPersistedPlanStep,
  resolvePlanStepApproval,
  submitPlanSteps,
  type ApprovalDecision,
} from "../queue/PlanQueueRuntime.js";
import { PolicyViolationError, type PolicyEnforcer } from "../policy/PolicyEnforcer.js";
import type { SseQuotaManager } from "../server/SseQuotaManager.js";
import type { AppConfig } from "../config.js";
import { normalizeTenantIdInput } from "../tenants/tenantIds.js";
import type { RateLimitStore } from "../rateLimit/store.js";
import { enforceRateLimit } from "../http/rateLimit.js";

import {
  toPlanSubject,
  toAuditSubject,
  toPolicySubject,
  subjectsMatch,
  getRequestIds,
  buildPolicyErrorMessage,
  formatApprovalSummary,
  waitForDrain,
  resolveAuthFailure,
  buildAuthFailureAuditDetails,
  respondWithInvalidTenant,
  sanitizePlanEvent,
  setNoCacheHeaders,
  shouldStream,
} from "../http/helpers.js";
import type { ExtendedRequest } from "../http/types.js";
import type { PlanStepState } from "../plan/validation.js";
import { appLogger, normalizeError } from "../observability/logger.js";
import { registerWorkflowForPlan } from "../queue/PlanQueueRuntime.js";
import { caseService } from "../cases/CaseService.js";

export class PlanController {
  constructor(
    private readonly config: AppConfig,
    private readonly policy: PolicyEnforcer,
    private readonly rateLimiter: RateLimitStore,
    private readonly quotaManager: SseQuotaManager
  ) {}

  async createPlan(req: ExtendedRequest, res: Response): Promise<void> {
    const agent = extractAgent(req);
    const session = req.auth?.session;
    let auditSubject = toAuditSubject(session);

    if (this.config.auth.oidc.enabled && !session) {
      const failure = resolveAuthFailure(req);
      respondWithError(res, failure.status, {
        code: failure.code,
        message: failure.message,
        details: failure.details,
      });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "plan.create",
        outcome: "denied",
        agent,
        requestId,
        traceId,
        subject: auditSubject,
        details: buildAuthFailureAuditDetails(failure),
      });
      return;
    }

    const tenantNormalization = normalizeTenantIdInput(session?.tenantId);
    if (tenantNormalization.error) {
      respondWithInvalidTenant(res, "plan.create", agent, tenantNormalization.error);
      return;
    }
    const normalizedSession =
      session && tenantNormalization.tenantId !== session.tenantId
        ? { ...session, tenantId: tenantNormalization.tenantId }
        : session;
    const planSubject = normalizedSession ? toPlanSubject(normalizedSession) : undefined;
    auditSubject = normalizedSession ? toAuditSubject(normalizedSession) : auditSubject;
    const identity = createRequestIdentity(req, this.config, planSubject);
    const requestAgent = identity.agentName ?? agent;
    const rateLimitBuckets = buildRateLimitBuckets(
      "plan",
      this.config.server.rateLimits.plan,
    );
    const rateDecision = await enforceRateLimit(
      this.rateLimiter,
      "plan",
      identity,
      rateLimitBuckets,
    );
    if (!rateDecision.allowed) {
      respondWithError(
        res,
        429,
        {
          code: "too_many_requests",
          message: "plan creation rate limit exceeded",
        },
        rateDecision.retryAfterMs
          ? { retryAfterMs: rateDecision.retryAfterMs }
          : undefined,
      );
      logAuditEvent({
        action: "plan.create",
        outcome: "denied",
        agent: requestAgent,
        details: { reason: "rate_limited" },
        subject: auditSubject,
      });
      return;
    }

    const parsed = PlanRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      respondWithValidationError(
        res,
        formatValidationIssues(parsed.error.issues),
      );
      logAuditEvent({
        action: "plan.create",
        outcome: "failure",
        agent: requestAgent,
        subject: auditSubject,
        details: { reason: "invalid_request" },
      });
      return;
    }

    let policyDecision: Awaited<ReturnType<typeof this.policy.enforceHttpAction>>;
    try {
      policyDecision = await this.policy.enforceHttpAction({
        action: "http.post.plan",
        requiredCapabilities: ["plan.create"],
        agent: requestAgent,
        traceId: getRequestContext()?.traceId,
        subject: toPolicySubject(normalizedSession),
        runMode: this.config.runMode,
      });
    } catch (error) {
      if (error instanceof PolicyViolationError) {
        const { requestId, traceId } = getRequestIds(res);
        respondWithError(res, error.status ?? 403, {
          code: "forbidden",
          message: buildPolicyErrorMessage(error.details),
          details: error.details,
        });
        logAuditEvent({
          action: "plan.create",
          outcome: "denied",
          agent: requestAgent,
          requestId,
          traceId,
          subject: auditSubject,
          details: { deny: error.details, error: error.message },
        });
        return;
      }
      throw error;
    }
    if (!policyDecision.allow) {
      respondWithError(res, 403, {
        code: "forbidden",
        message: buildPolicyErrorMessage(policyDecision.deny),
        details: policyDecision.deny,
      });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "plan.create",
        outcome: "denied",
        agent: requestAgent,
        requestId,
        traceId,
        subject: auditSubject,
        details: { deny: policyDecision.deny },
      });
      return;
    }

    try {
      const desiredCaseId = parsed.data.caseId;
      let resolvedCaseId = desiredCaseId;
      let caseProjectId: string | undefined;
      if (resolvedCaseId) {
        const existingCase = caseService.getCase(resolvedCaseId);
        if (!existingCase || existingCase.tenantId !== planSubject?.tenantId) {
          respondWithError(res, 404, { code: "not_found", message: "case not found" });
          return;
        }
        caseProjectId = existingCase.projectId;
      } else if (planSubject?.sessionId) {
        const sessionCase = caseService.getOrCreateCaseForSession(planSubject.sessionId, {
          title: `Session ${planSubject.sessionId}`,
          tenantId: planSubject.tenantId,
          projectId: planSubject.tenantId,
          status: "open",
        });
        resolvedCaseId = sessionCase.id;
        caseProjectId = sessionCase.projectId;
      }

      const plan = await createPlan(parsed.data.goal, {
        retentionDays: this.config.retention.planArtifactsDays,
        subject: planSubject,
      });
      const { requestId, traceId } = getRequestIds(res);
      const workflow = registerWorkflowForPlan(plan, {
        tenantId: planSubject?.tenantId,
        projectId: caseProjectId,
        caseId: resolvedCaseId,
        traceId,
        requestId,
        subject: planSubject,
      });
      if (resolvedCaseId) {
        caseService.attachWorkflow(resolvedCaseId, workflow.id);
      }
      if (planSubject) {
        await submitPlanSteps(plan, traceId, requestId, planSubject);
      } else {
        await submitPlanSteps(plan, traceId, requestId);
      }
      res.status(201).json({ plan, requestId, traceId, workflowId: workflow.id, caseId: resolvedCaseId });
      logAuditEvent({
        action: "plan.create",
        outcome: "success",
        agent: requestAgent,
        requestId,
        traceId,
        subject: auditSubject,
        details: { planId: plan.id, workflowId: workflow.id, caseId: resolvedCaseId },
      });
    } catch (error) {
      respondWithUnexpectedError(res, error);
      logAuditEvent({
        action: "plan.create",
        outcome: "failure",
        agent: requestAgent,
        subject: auditSubject,
        details: { reason: "exception" },
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getPlanEvents(req: ExtendedRequest, res: Response): Promise<void> {
    const planIdResult = PlanIdSchema.safeParse(req.params.id);
    if (!planIdResult.success) {
      respondWithValidationError(
        res,
        formatValidationIssues(planIdResult.error.issues),
      );
      return;
    }
    const planId = planIdResult.data;
    const wantsStream = shouldStream(req);
    const identity = createRequestIdentity(
      req,
      this.config,
      req.auth?.session ? toPlanSubject(req.auth.session) : undefined,
    );
    const rateDecision = await enforceRateLimit(
      this.rateLimiter,
      "plan-events",
      identity,
      buildRateLimitBuckets("plan-events", this.config.server.rateLimits.plan),
    );
    if (!rateDecision.allowed) {
      respondWithError(
        res,
        429,
        {
          code: "too_many_requests",
          message: wantsStream
            ? "too many concurrent event streams"
            : "plan events rate limit exceeded",
        },
        rateDecision.retryAfterMs
          ? { retryAfterMs: rateDecision.retryAfterMs }
          : undefined,
      );
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
    const requesterSubject = req.auth?.session
      ? toPlanSubject(req.auth.session)
      : undefined;

    const baseDecision = await this.policy.enforceHttpAction({
      action: "http.get.plan.events",
      requiredCapabilities: ["plan.read"],
      agent,
      traceId: getRequestContext()?.traceId,
      subject: toPolicySubject(req.auth?.session),
      runMode: this.config.runMode,
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
        message: wantsStream
          ? "subject does not match plan owner"
          : "subject does not match plan owner",
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
      const historyDecision = await this.policy.enforceHttpAction({
        action: "http.get.plan.events.history",
        requiredCapabilities: ["plan.read"],
        agent,
        traceId: getRequestContext()?.traceId,
        subject: toPolicySubject(req.auth?.session),
        runMode: this.config.runMode,
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

    const streamDecision = await this.policy.enforceHttpAction({
      action: "http.get.plan.events.stream",
      requiredCapabilities: ["plan.read"],
      agent,
      traceId: getRequestContext()?.traceId,
      subject: toPolicySubject(req.auth?.session),
      runMode: this.config.runMode,
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

    const quotaRelease = this.quotaManager.acquire({
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

    const keepAliveInterval = Math.max(1, this.config.server.sseKeepAliveMs);
    const keepAlive = setInterval(() => {
      void enqueue(": keep-alive\n\n").catch(() => undefined);
    }, keepAliveInterval);
    keepAlive.unref?.();

    const history = getPlanHistory(planId).map(sanitizePlanEvent);
    try {
      for (const event of history) {
        await enqueue(
          `event: plan.step\n` + `data: ${JSON.stringify(event)}\n\n`,
        );
      }
    } catch (error) {
      clearInterval(keepAlive);
      responder.destroy();
      releaseResources();
      
      const normalized = normalizeError(error);
      appLogger.error({ err: normalized, requestId, traceId }, "Plan event stream error");
      
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

    const unsubscribe = subscribeToPlanSteps(
      planId,
      (event: StoredPlanStepEvent) => {
        void enqueue(
          `event: plan.step\n` + `data: ${JSON.stringify(event)}\n\n`,
        ).catch(() => {
          unsubscribe();
          clearInterval(keepAlive);
          responder.destroy();
          releaseResources();
        });
      },
    );

    const close = () => {
      unsubscribe();
      clearInterval(keepAlive);
      releaseResources();
    };

    req.on("close", close);
    res.on("close", close);
    res.on("finish", close);
  }

  async approveStep(req: ExtendedRequest, res: Response): Promise<void> {
    await this.handleApproval(req, res, undefined, "plan.step.approve");
  }

  async rejectStep(req: ExtendedRequest, res: Response): Promise<void> {
    await this.handleApproval(req, res, "rejected", "plan.step.reject");
  }

  private async handleApproval(
    req: ExtendedRequest,
    res: Response,
    overrideDecision: ApprovalDecision | undefined,
    actionName: string,
  ) {
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
        details: {
          reason: "invalid_params",
          planId: rawPlanId,
          stepId: rawStepId,
        },
      });
      return;
    }
    const planId = planIdResult.data;
    const stepId = stepIdResult.data;

    if (this.config.auth.oidc.enabled) {
      const session = req.auth?.session;
      if (!session) {
        const failure = resolveAuthFailure(req);
        respondWithError(res, failure.status, {
          code: failure.code,
          message: failure.message,
          details: failure.details,
        });
        const { requestId, traceId } = getRequestIds(res);
        logAuditEvent({
          action: actionName,
          outcome: "denied",
          agent,
          subject: subjectForAudit,
          requestId,
          traceId,
          details: {
            planId,
            stepId,
            ...buildAuthFailureAuditDetails(failure),
          },
        });
        return;
      }
    }

    const bodyResult = PlanApprovalSchema.safeParse(req.body ?? {});
    if (!bodyResult.success) {
      respondWithValidationError(
        res,
        formatValidationIssues(bodyResult.error.issues),
      );
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

    const subject = req.auth?.session
      ? toPlanSubject(req.auth.session)
      : undefined;
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

    const policyDecision = await this.policy.enforceHttpAction({
      action:
        decision === "approved"
          ? "http.post.plan.steps.approve"
          : "http.post.plan.steps.reject",
      requiredCapabilities: ["plan.approve"],
      agent: extractAgent(req),
      traceId: getRequestContext()?.traceId,
      subject: toPolicySubject(req.auth?.session),
      runMode: this.config.runMode,
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

    const finalSummary = formatApprovalSummary(
      decision,
      payload.rationale,
      summary,
    );
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
  }
}

