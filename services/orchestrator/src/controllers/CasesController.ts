import type { Response } from "express";

import { caseService } from "../cases/CaseService.js";
import type { AppConfig } from "../config.js";
import {
  CaseArtifactSchema,
  CaseCreateSchema,
  CaseListQuerySchema,
  CaseTaskCreateSchema,
  formatValidationIssues,
} from "../http/validation.js";
import { respondWithError, respondWithValidationError, respondWithUnexpectedError } from "../http/errors.js";
import { logAuditEvent } from "../observability/audit.js";
import { getRequestIds } from "../http/helpers.js";
import type { ExtendedRequest } from "../http/types.js";
import { normalizeTenantIdInput } from "../tenants/tenantIds.js";
import { createRequestIdentity, buildRateLimitBuckets, extractAgent } from "../http/requestIdentity.js";
import type { RateLimitStore } from "../rateLimit/store.js";
import { enforceRateLimit } from "../http/rateLimit.js";
import { appLogger, normalizeError } from "../observability/logger.js";
import { listWorkflows } from "../queue/PlanQueueRuntime.js";

export class CasesController {
  constructor(private readonly config: AppConfig, private readonly rateLimiter: RateLimitStore) {}

  async createCase(req: ExtendedRequest, res: Response): Promise<void> {
    const session = req.auth?.session;
    const agent = extractAgent(req);
    if (!session) {
      respondWithError(res, 401, { code: "unauthorized", message: "session is required" });
      return;
    }
    const tenantNormalization = normalizeTenantIdInput(session.tenantId);
    if (tenantNormalization.error) {
      respondWithError(res, 400, {
        code: "invalid_tenant",
        message: tenantNormalization.error,
      });
      return;
    }

    const identity = createRequestIdentity(req, this.config, {
      sessionId: session.id,
      tenantId: tenantNormalization.tenantId,
      userId: session.subject,
      roles: session.roles,
      scopes: session.scopes,
      email: session.email,
      name: session.name,
    });
    const rateDecision = await enforceRateLimit(
      this.rateLimiter,
      "cases",
      identity,
      buildRateLimitBuckets("cases", this.config.server.rateLimits.plan),
    );
    if (!rateDecision.allowed) {
      respondWithError(
        res,
        429,
        { code: "too_many_requests", message: "case creation rate limit exceeded" },
        rateDecision.retryAfterMs ? { retryAfterMs: rateDecision.retryAfterMs } : undefined,
      );
      return;
    }

    const parsed = CaseCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      respondWithValidationError(res, formatValidationIssues(parsed.error.issues));
      return;
    }

    try {
      const record = caseService.createCase({
        ...parsed.data,
        tenantId: tenantNormalization.tenantId,
      });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "case.create",
        outcome: "success",
        agent,
        requestId,
        traceId,
        subject: { tenantId: tenantNormalization.tenantId, userId: session.subject, sessionId: session.id, roles: session.roles },
        details: { caseId: record.id },
      });
      res.status(201).json({ case: record });
    } catch (error) {
      appLogger.error({ err: normalizeError(error) }, "failed to create case");
      respondWithUnexpectedError(res, error);
    }
  }

  async listCases(req: ExtendedRequest, res: Response): Promise<void> {
    const session = req.auth?.session;
    if (!session) {
      respondWithError(res, 401, { code: "unauthorized", message: "session is required" });
      return;
    }
    const tenantNormalization = normalizeTenantIdInput(session.tenantId);
    if (tenantNormalization.error) {
      respondWithError(res, 400, {
        code: "invalid_tenant",
        message: tenantNormalization.error,
      });
      return;
    }

    const parsedQuery = CaseListQuerySchema.safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      respondWithValidationError(res, formatValidationIssues(parsedQuery.error.issues));
      return;
    }

    const cases = caseService.listCases({
      tenantId: tenantNormalization.tenantId,
      projectId: parsedQuery.data.projectId,
    });
    res.json({ cases });
  }

  async createTask(req: ExtendedRequest, res: Response): Promise<void> {
    const session = req.auth?.session;
    if (!session) {
      respondWithError(res, 401, { code: "unauthorized", message: "session is required" });
      return;
    }
    const tenantNormalization = normalizeTenantIdInput(session.tenantId);
    if (tenantNormalization.error) {
      respondWithError(res, 400, {
        code: "invalid_tenant",
        message: tenantNormalization.error,
      });
      return;
    }

    const parsed = CaseTaskCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      respondWithValidationError(res, formatValidationIssues(parsed.error.issues));
      return;
    }

    const caseId = req.params["id"];
    const target = caseService.getCase(caseId);
    if (!target || target.tenantId !== tenantNormalization.tenantId) {
      respondWithError(res, 404, { code: "not_found", message: "case not found" });
      return;
    }

    try {
      const task = caseService.createTask({
        caseId,
        title: parsed.data.title,
        assignee: parsed.data.assignee,
        metadata: parsed.data.metadata,
      });
      res.status(201).json({ task });
    } catch (error) {
      appLogger.error({ err: normalizeError(error) }, "failed to create case task");
      respondWithUnexpectedError(res, error);
    }
  }

  async attachArtifact(req: ExtendedRequest, res: Response): Promise<void> {
    const session = req.auth?.session;
    if (!session) {
      respondWithError(res, 401, { code: "unauthorized", message: "session is required" });
      return;
    }
    const tenantNormalization = normalizeTenantIdInput(session.tenantId);
    if (tenantNormalization.error) {
      respondWithError(res, 400, {
        code: "invalid_tenant",
        message: tenantNormalization.error,
      });
      return;
    }

    const parsed = CaseArtifactSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      respondWithValidationError(res, formatValidationIssues(parsed.error.issues));
      return;
    }

    const caseId = req.params["id"];
    const target = caseService.getCase(caseId);
    if (!target || target.tenantId !== tenantNormalization.tenantId) {
      respondWithError(res, 404, { code: "not_found", message: "case not found" });
      return;
    }

    try {
      const artifact = caseService.attachArtifact({ caseId, ...parsed.data });
      res.status(201).json({ artifact });
    } catch (error) {
      appLogger.error({ err: normalizeError(error) }, "failed to attach artifact");
      respondWithUnexpectedError(res, error);
    }
  }

  async listWorkflows(req: ExtendedRequest, res: Response): Promise<void> {
    const session = req.auth?.session;
    if (!session) {
      respondWithError(res, 401, { code: "unauthorized", message: "session is required" });
      return;
    }
    const tenantNormalization = normalizeTenantIdInput(session.tenantId);
    if (tenantNormalization.error) {
      respondWithError(res, 400, {
        code: "invalid_tenant",
        message: tenantNormalization.error,
      });
      return;
    }

    const parsed = CaseListQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      respondWithValidationError(res, formatValidationIssues(parsed.error.issues));
      return;
    }

    const workflows = listWorkflows({
      tenantId: tenantNormalization.tenantId,
      projectId: parsed.data.projectId,
    });
    res.json({ workflows });
  }
}
