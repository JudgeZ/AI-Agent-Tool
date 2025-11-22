import type { Response } from "express";
import type { AppConfig } from "../config.js";
import type { ExtendedRequest } from "../http/types.js";
import {
  createRequestIdentity,
  buildRateLimitBuckets,
  extractAgent,
} from "../http/requestIdentity.js";
import {
  toPlanSubject,
  toAuditSubject,
  toPolicySubject,
  getRequestIds,
  buildPolicyErrorMessage,
} from "../http/helpers.js";
import { enforceRateLimit } from "../http/rateLimit.js";
import type { RateLimitStore } from "../rateLimit/store.js";
import {
  respondWithError,
  respondWithValidationError,
  respondWithUnexpectedError,
} from "../http/errors.js";
import { logAuditEvent } from "../observability/audit.js";
import { getRequestContext } from "../observability/requestContext.js";
import {
  ChatRequestSchema,
  formatValidationIssues,
  type ChatRequestPayload,
} from "../http/validation.js";
import { routeChat } from "../providers/ProviderRegistry.js";
import type { PolicyEnforcer } from "../policy/PolicyEnforcer.js";

export class ChatController {
  constructor(
    private readonly config: AppConfig,
    private readonly rateLimiter: RateLimitStore,
    private readonly policy: PolicyEnforcer,
  ) {}

  async chat(req: ExtendedRequest, res: Response): Promise<void> {
    const identity = createRequestIdentity(
      req,
      this.config,
      req.auth?.session ? toPlanSubject(req.auth.session) : undefined,
    );
    const rateDecision = await enforceRateLimit(
      this.rateLimiter,
      "chat",
      identity,
      buildRateLimitBuckets("chat", this.config.server.rateLimits.chat),
    );
    if (!rateDecision.allowed) {
      respondWithError(
        res,
        429,
        {
          code: "too_many_requests",
          message: "chat rate limit exceeded",
        },
        rateDecision.retryAfterMs
          ? { retryAfterMs: rateDecision.retryAfterMs }
          : undefined,
      );
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
      respondWithValidationError(
        res,
        formatValidationIssues(parsed.error.issues),
      );
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

    const agentName = identity.agentName ?? extractAgent(req);

    const policyDecision = await this.policy.enforceHttpAction({
      action: "http.post.chat",
      requiredCapabilities: ["chat.interact"],
      agent: agentName,
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
        action: "chat.route",
        outcome: "denied",
        agent: agentName,
        subject: toAuditSubject(req.auth?.session),
        requestId,
        traceId,
        details: { deny: policyDecision.deny },
      });
      return;
    }

    try {
      const chatPayload = parsed.data as ChatRequestPayload;
      const tenantContext = req.auth?.session?.tenantId
        ? { tenantId: req.auth.session.tenantId }
        : undefined;
      const responsePayload = tenantContext
        ? await routeChat(chatPayload, tenantContext)
        : await routeChat(chatPayload);
      const { requestId, traceId } = getRequestIds(res);
      res.json({ response: responsePayload, requestId, traceId });
      logAuditEvent({
        action: "chat.route",
        outcome: "success",
        agent: agentName,
        subject: toAuditSubject(req.auth?.session),
        requestId,
        traceId,
        details: {
          model: parsed.data.model,
          provider: parsed.data.provider,
          routing: parsed.data.routing,
          temperature: parsed.data.temperature,
          messageCount: Array.isArray(parsed.data.messages)
            ? parsed.data.messages.length
            : undefined,
        },
      });
    } catch (error) {
      respondWithUnexpectedError(res, error);
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "chat.route",
        outcome: "failure",
        agent: agentName,
        subject: toAuditSubject(req.auth?.session),
        requestId,
        traceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
