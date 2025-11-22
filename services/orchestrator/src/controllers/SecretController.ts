import type { Response } from "express";
import type { AppConfig } from "../config.js";
import type { ExtendedRequest } from "../http/types.js";
import {
  createRequestIdentity,
  buildRateLimitBuckets,
  extractAgent,
} from "../http/requestIdentity.js";
import { enforceRateLimit } from "../http/rateLimit.js";
import type { RateLimitStore } from "../rateLimit/store.js";
import {
  toAuditSubject,
  getRequestIds,
  resolveAuthFailure,
  buildAuthFailureAuditDetails,
  buildPolicyErrorMessage,
  toPolicySubject,
} from "../http/helpers.js";
import { respondWithError, respondWithValidationError, respondWithUnexpectedError } from "../http/errors.js";
import { logAuditEvent, type AuditSubject } from "../observability/audit.js";
import { getRequestContext } from "../observability/requestContext.js";
import {
  SecretKeySchema,
  SecretRotateSchema,
  SecretPromoteSchema,
  formatValidationIssues,
} from "../http/validation.js";
import { getVersionedSecretsManager } from "../providers/ProviderRegistry.js";
import type { PolicyEnforcer } from "../policy/PolicyEnforcer.js";

export class SecretController {
  constructor(
    private readonly config: AppConfig,
    private readonly policy: PolicyEnforcer,
    private readonly rateLimiter: RateLimitStore
  ) {}

  private async checkRateLimit(
    req: ExtendedRequest,
    res: Response,
    action: string,
    subject?: AuditSubject
  ): Promise<boolean> {
    const identity = createRequestIdentity(req, this.config);
    const agent = identity.agentName ?? extractAgent(req);
    const buckets = buildRateLimitBuckets(
      "secrets",
      this.config.server.rateLimits.secrets,
    );
    const rateDecision = await enforceRateLimit(
      this.rateLimiter,
      "secrets",
      identity,
      buckets,
    );

    if (!rateDecision.allowed) {
      const { requestId, traceId } = getRequestIds(res);
      respondWithError(
        res,
        429,
        {
          code: "too_many_requests",
          message: "secrets rate limit exceeded",
        },
        rateDecision.retryAfterMs
          ? { retryAfterMs: rateDecision.retryAfterMs }
          : undefined,
      );
      logAuditEvent({
        action,
        outcome: "denied",
        agent,
        subject,
        requestId,
        traceId,
        details: {
          reason: "rate_limited",
          retryAfterMs: rateDecision.retryAfterMs ?? undefined,
        },
      });
      return false;
    }
    return true;
  }

  async rotateSecret(req: ExtendedRequest, res: Response): Promise<void> {
    const agent = extractAgent(req);
    const subject = toAuditSubject(req.auth?.session);

    if (!(await this.checkRateLimit(req, res, "secrets.rotate", subject))) {
      return;
    }

    const keyResult = SecretKeySchema.safeParse(req.params.key);
    if (!keyResult.success) {
      respondWithValidationError(
        res,
        formatValidationIssues(keyResult.error.issues),
      );
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
    if (this.config.auth.oidc.enabled && !req.auth?.session) {
      const failure = resolveAuthFailure(req);
      respondWithError(res, failure.status, {
        code: failure.code,
        message: failure.message,
        details: failure.details,
      });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "secrets.rotate",
        outcome: "denied",
        agent,
        subject,
        requestId,
        traceId,
        details: {
          key: keyResult.success ? keyResult.data : req.params.key,
          ...buildAuthFailureAuditDetails(failure),
        },
      });
      return;
    }
    const bodyResult = SecretRotateSchema.safeParse(req.body ?? {});
    if (!bodyResult.success) {
      respondWithValidationError(
        res,
        formatValidationIssues(bodyResult.error.issues),
      );
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

    const policyDecision = await this.policy.enforceHttpAction({
      action: "http.post.secrets.rotate",
      requiredCapabilities: ["secrets.manage"],
      agent,
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
      const version = await manager.rotate(
        keyResult.data,
        bodyResult.data.value,
        {
          retain: bodyResult.data.retain,
          labels: bodyResult.data.labels,
        },
      );
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
  }

  async promoteSecret(req: ExtendedRequest, res: Response): Promise<void> {
    const agent = extractAgent(req);
    const subject = toAuditSubject(req.auth?.session);

    if (!(await this.checkRateLimit(req, res, "secrets.promote", subject))) {
      return;
    }

    const keyResult = SecretKeySchema.safeParse(req.params.key);
    if (!keyResult.success) {
      respondWithValidationError(
        res,
        formatValidationIssues(keyResult.error.issues),
      );
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
    if (this.config.auth.oidc.enabled && !req.auth?.session) {
      const failure = resolveAuthFailure(req);
      respondWithError(res, failure.status, {
        code: failure.code,
        message: failure.message,
        details: failure.details,
      });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "secrets.promote",
        outcome: "denied",
        agent,
        subject,
        requestId,
        traceId,
        details: {
          key: keyResult.success ? keyResult.data : req.params.key,
          ...buildAuthFailureAuditDetails(failure),
        },
      });
      return;
    }
    const bodyResult = SecretPromoteSchema.safeParse(req.body ?? {});
    if (!bodyResult.success) {
      respondWithValidationError(
        res,
        formatValidationIssues(bodyResult.error.issues),
      );
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

    const policyDecision = await this.policy.enforceHttpAction({
      action: "http.post.secrets.promote",
      requiredCapabilities: ["secrets.manage"],
      agent,
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
      const version = await manager.promote(
        keyResult.data,
        bodyResult.data.versionId,
      );
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
        details: {
          key: keyResult.data,
          versionId: bodyResult.success ? bodyResult.data.versionId : undefined,
        },
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getSecretVersions(req: ExtendedRequest, res: Response): Promise<void> {
    const agent = extractAgent(req);
    const subject = toAuditSubject(req.auth?.session);

    if (!(await this.checkRateLimit(req, res, "secrets.versions", subject))) {
      return;
    }

    const keyResult = SecretKeySchema.safeParse(req.params.key);
    if (!keyResult.success) {
      respondWithValidationError(
        res,
        formatValidationIssues(keyResult.error.issues),
      );
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
    if (this.config.auth.oidc.enabled && !req.auth?.session) {
      const failure = resolveAuthFailure(req);
      respondWithError(res, failure.status, {
        code: failure.code,
        message: failure.message,
        details: failure.details,
      });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "secrets.versions",
        outcome: "denied",
        agent,
        subject,
        requestId,
        traceId,
        details: {
          key: keyResult.success ? keyResult.data : req.params.key,
          ...buildAuthFailureAuditDetails(failure),
        },
      });
      return;
    }

    const policyDecision = await this.policy.enforceHttpAction({
      action: "http.get.secrets.versions",
      requiredCapabilities: ["secrets.manage"],
      agent,
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
        details: { key: keyResult.data, versions: versions.versions.length },
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
  }
}

