import type { Response } from "express";

import { normalizeTenantIdInput } from "../tenants/tenantIds.js";
import { getCaseService } from "../cases/CaseService.js";
import type { AppConfig } from "../config.js";
import { respondWithUnexpectedError, respondWithError, respondWithValidationError } from "../http/errors.js";
import type { ExtendedRequest } from "../http/types.js";
import { createRequestIdentity, buildRateLimitBuckets } from "../http/requestIdentity.js";
import { enforceRateLimit } from "../http/rateLimit.js";
import type { RateLimitStore } from "../rateLimit/store.js";
import {
  CaseCreateSchema,
  CaseListQuerySchema,
  TaskCreateSchema,
  ArtifactCreateSchema,
  formatValidationIssues,
} from "../http/validation.js";
import {
  buildAuthFailureAuditDetails,
  getRequestIds,
  resolveAuthFailure,
  respondWithInvalidTenant,
  toAuditSubject,
  toPlanSubject,
} from "../http/helpers.js";
import { logAuditEvent } from "../observability/audit.js";
import { appLogger, normalizeError } from "../observability/logger.js";

export class CaseController {
  private readonly logger = appLogger.child({ component: "CaseController" });
  private readonly caseService = getCaseService();

  constructor(private readonly config: AppConfig, private readonly rateLimiter: RateLimitStore) {}

  private requireSession(req: ExtendedRequest, res: Response): ExtendedRequest["auth"]["session"] | undefined {
    const session = req.auth?.session;
    if (this.config.auth.oidc.enabled && !session) {
      const failure = resolveAuthFailure(req);
      respondWithError(res, failure.status, {
        code: failure.code,
        message: failure.message,
        details: failure.details,
      });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "cases.access",
        outcome: "denied",
        requestId,
        traceId,
        details: buildAuthFailureAuditDetails(failure),
      });
      return undefined;
    }
    if (!this.config.auth.oidc.enabled && !session) {
      respondWithError(res, 401, { code: "unauthorized", message: "session is required" });
      return undefined;
    }
    return session;
  }

  private async checkRateLimit(
    req: ExtendedRequest,
    res: Response,
    endpoint: string,
    auditAction: string,
  ): Promise<boolean> {
    const identity = createRequestIdentity(
      req,
      this.config,
      req.auth?.session ? toPlanSubject(req.auth.session) : undefined,
    );
    const rateDecision = await enforceRateLimit(
      this.rateLimiter,
      endpoint,
      identity,
      buildRateLimitBuckets(endpoint, this.config.server.rateLimits.cases),
    );
    if (rateDecision.allowed) {
      return true;
    }
    respondWithError(
      res,
      429,
      { code: "too_many_requests", message: `${endpoint} rate limit exceeded` },
      rateDecision.retryAfterMs ? { retryAfterMs: rateDecision.retryAfterMs } : undefined,
    );
    const { requestId, traceId } = getRequestIds(res);
    logAuditEvent({
      action: auditAction,
      outcome: "denied",
      subject: toAuditSubject(req.auth?.session),
      requestId,
      traceId,
      details: { reason: "rate_limited" },
    });
    return false;
  }

  async listCases(req: ExtendedRequest, res: Response): Promise<void> {
    const session = this.requireSession(req, res);
    if (!session) return;

    if (!(await this.checkRateLimit(req, res, "cases", "cases.list"))) {
      return;
    }

    const tenantNormalization = normalizeTenantIdInput(session.tenantId);
    if (tenantNormalization.error) {
      respondWithInvalidTenant(res, "cases.list", session.subject, tenantNormalization.error);
      return;
    }

    const parsedQuery = CaseListQuerySchema.safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      respondWithValidationError(res, formatValidationIssues(parsedQuery.error.issues));
      return;
    }

    try {
      const cases = await this.caseService.listCases({
        tenantId: tenantNormalization.tenantId,
        projectId: parsedQuery.data.projectId,
        status: parsedQuery.data.status,
      });
      res.json({ cases });
    } catch (error) {
      this.logger.error({ err: normalizeError(error) }, "failed to list cases");
      respondWithUnexpectedError(res, error);
    }
  }

  async createCase(req: ExtendedRequest, res: Response): Promise<void> {
    const session = this.requireSession(req, res);
    if (!session) return;

    if (!(await this.checkRateLimit(req, res, "cases", "cases.create"))) {
      return;
    }

    const tenantNormalization = normalizeTenantIdInput(session.tenantId);
    if (tenantNormalization.error) {
      respondWithInvalidTenant(res, "cases.create", session.subject, tenantNormalization.error);
      return;
    }

    const parsed = CaseCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      respondWithValidationError(res, formatValidationIssues(parsed.error.issues));
      return;
    }

    try {
      const created = await this.caseService.createCase({
        tenantId: tenantNormalization.tenantId,
        projectId: parsed.data.projectId,
        title: parsed.data.title,
        description: parsed.data.description,
        status: parsed.data.status,
        metadata: parsed.data.metadata,
      });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "cases.create",
        outcome: "success",
        subject: { tenantId: tenantNormalization.tenantId },
        resource: created.id,
        requestId,
        traceId,
      });
      res.status(201).json({ case: created });
    } catch (error) {
      this.logger.error({ err: normalizeError(error) }, "failed to create case");
      respondWithUnexpectedError(res, error);
    }
  }

  async createTask(req: ExtendedRequest, res: Response): Promise<void> {
    const session = this.requireSession(req, res);
    if (!session) return;

    if (!(await this.checkRateLimit(req, res, "cases", "cases.tasks.create"))) {
      return;
    }

    const tenantNormalization = normalizeTenantIdInput(session.tenantId);
    if (tenantNormalization.error) {
      respondWithInvalidTenant(res, "cases.tasks.create", session.subject, tenantNormalization.error);
      return;
    }

    const caseId = req.params["id"];
    if (!caseId) {
      respondWithError(res, 400, { code: "invalid_request", message: "case id is required" });
      return;
    }

    const parsed = TaskCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      respondWithValidationError(res, formatValidationIssues(parsed.error.issues));
      return;
    }

    try {
      const existing = await this.caseService.getCase(caseId);
      if (!existing || existing.tenantId !== tenantNormalization.tenantId) {
        respondWithError(res, 404, { code: "not_found", message: "case not found" });
        return;
      }
      const task = await this.caseService.createTask({
        caseId,
        title: parsed.data.title,
        description: parsed.data.description,
        status: parsed.data.status,
        metadata: parsed.data.metadata,
      });
      res.status(201).json({ task });
    } catch (error) {
      this.logger.error({ err: normalizeError(error) }, "failed to create task for case");
      respondWithUnexpectedError(res, error);
    }
  }

  async listTasks(req: ExtendedRequest, res: Response): Promise<void> {
    const session = this.requireSession(req, res);
    if (!session) return;

    if (!(await this.checkRateLimit(req, res, "cases", "cases.tasks.list"))) {
      return;
    }

    const caseId = req.params["id"];
    if (!caseId) {
      respondWithError(res, 400, { code: "invalid_request", message: "case id is required" });
      return;
    }

    try {
      const existing = await this.caseService.getCase(caseId);
      if (!existing) {
        respondWithError(res, 404, { code: "not_found", message: "case not found" });
        return;
      }
      const tenantNormalization = normalizeTenantIdInput(session.tenantId);
      if (tenantNormalization.error) {
        respondWithInvalidTenant(res, "cases.tasks.list", session.subject, tenantNormalization.error);
        return;
      }
      if (existing.tenantId !== tenantNormalization.tenantId) {
        respondWithError(res, 403, { code: "forbidden", message: "cross-tenant access denied" });
        return;
      }
      const tasks = await this.caseService.listTasks(caseId);
      res.json({ tasks });
    } catch (error) {
      this.logger.error({ err: normalizeError(error) }, "failed to list tasks for case");
      respondWithUnexpectedError(res, error);
    }
  }

  async attachArtifact(req: ExtendedRequest, res: Response): Promise<void> {
    const session = this.requireSession(req, res);
    if (!session) return;

    if (!(await this.checkRateLimit(req, res, "cases", "cases.artifacts.attach"))) {
      return;
    }

    const caseId = req.params["id"];
    if (!caseId) {
      respondWithError(res, 400, { code: "invalid_request", message: "case id is required" });
      return;
    }

    const parsed = ArtifactCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      respondWithValidationError(res, formatValidationIssues(parsed.error.issues));
      return;
    }

    try {
      const existing = await this.caseService.getCase(caseId);
      if (!existing) {
        respondWithError(res, 404, { code: "not_found", message: "case not found" });
        return;
      }
      const tenantNormalization = normalizeTenantIdInput(session.tenantId);
      if (tenantNormalization.error) {
        respondWithInvalidTenant(res, "cases.artifacts.attach", session.subject, tenantNormalization.error);
        return;
      }
      if (existing.tenantId !== tenantNormalization.tenantId) {
        respondWithError(res, 403, { code: "forbidden", message: "cross-tenant access denied" });
        return;
      }
      const artifact = await this.caseService.attachArtifact({
        caseId,
        type: parsed.data.type,
        ref: parsed.data.ref,
        metadata: parsed.data.metadata,
      });
      res.status(201).json({ artifact });
    } catch (error) {
      this.logger.error({ err: normalizeError(error) }, "failed to attach artifact");
      respondWithUnexpectedError(res, error);
    }
  }
}
