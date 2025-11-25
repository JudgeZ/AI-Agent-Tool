import type { Response } from "express";

import type { AppConfig } from "../config.js";
import { getWorkflowEngine } from "../workflow/WorkflowEngine.js";
import { normalizeTenantIdInput } from "../tenants/tenantIds.js";
import type { ExtendedRequest } from "../http/types.js";
import { respondWithUnexpectedError, respondWithValidationError, respondWithError } from "../http/errors.js";
import { formatValidationIssues, CaseListQuerySchema } from "../http/validation.js";
import {
  buildAuthFailureAuditDetails,
  getRequestIds,
  resolveAuthFailure,
  respondWithInvalidTenant,
} from "../http/helpers.js";
import { logAuditEvent } from "../observability/audit.js";
import { appLogger, normalizeError } from "../observability/logger.js";

export class WorkflowController {
  private readonly logger = appLogger.child({ component: "WorkflowController" });

  constructor(private readonly config: AppConfig) {}

  private requireSession(req: ExtendedRequest, res: Response) {
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
        action: "workflows.access",
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

  async listWorkflows(req: ExtendedRequest, res: Response): Promise<void> {
    const session = this.requireSession(req, res);
    if (!session) return;

    const tenantNormalization = normalizeTenantIdInput(session.tenantId);
    if (tenantNormalization.error) {
      respondWithInvalidTenant(res, "workflows.list", session.subject, tenantNormalization.error);
      return;
    }

    const parsedQuery = CaseListQuerySchema.safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      respondWithValidationError(res, formatValidationIssues(parsedQuery.error.issues));
      return;
    }

    try {
      const workflows = getWorkflowEngine().listWorkflows({
        tenantId: tenantNormalization.tenantId,
        projectId: parsedQuery.data.projectId,
      });
      res.json({ workflows });
    } catch (error) {
      this.logger.error({ err: normalizeError(error) }, "failed to list workflows");
      respondWithUnexpectedError(res, error);
    }
  }
}
