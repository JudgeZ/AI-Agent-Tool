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
import { respondWithError } from "../http/errors.js";
import { logAuditEvent, type AuditSubject } from "../observability/audit.js";
import { toAuditSubject, getRequestIds } from "../http/helpers.js";

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

export class AuthController {
  constructor(
    private readonly config: AppConfig,
    private readonly rateLimiter: RateLimitStore
  ) {}

  private async checkRateLimit(
    req: ExtendedRequest,
    res: Response,
    type: "oauth" | "oidc",
    action: string,
    subject?: AuditSubject
  ): Promise<boolean> {
    const identity = createRequestIdentity(req, this.config);
    const agent = identity.agentName ?? extractAgent(req);
    const buckets = buildRateLimitBuckets(
      type,
      this.config.server.rateLimits.auth,
    );
    const rateDecision = await enforceRateLimit(
      this.rateLimiter,
      type,
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
          message: `${type} rate limit exceeded`,
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

  async oauthAuthorize(req: ExtendedRequest, res: Response): Promise<void> {
    if (await this.checkRateLimit(req, res, "oauth", "auth.oauth.authorize")) {
      await oauthAuthorize(req, res);
    }
  }

  async oauthCallback(req: ExtendedRequest, res: Response): Promise<void> {
    if (await this.checkRateLimit(req, res, "oauth", "auth.oauth.callback")) {
      await oauthCallback(req, res);
    }
  }

  async getOidcConfig(req: ExtendedRequest, res: Response): Promise<void> {
    const subject = toAuditSubject(req.auth?.session);
    if (
      await this.checkRateLimit(
        req,
        res,
        "oidc",
        "auth.oidc.config",
        subject,
      )
    ) {
      await getOidcConfiguration(req, res);
    }
  }

  async oidcCallback(req: ExtendedRequest, res: Response): Promise<void> {
    const subject = toAuditSubject(req.auth?.session);
    if (
      await this.checkRateLimit(
        req,
        res,
        "oidc",
        "auth.oidc.callback",
        subject,
      )
    ) {
      await handleOidcCallback(req, res);
    }
  }

  async getOidcSession(req: ExtendedRequest, res: Response): Promise<void> {
    const subject = toAuditSubject(req.auth?.session);
    if (
      await this.checkRateLimit(
        req,
        res,
        "oidc",
        "auth.oidc.session.get",
        subject,
      )
    ) {
      await getOidcSession(req, res);
    }
  }

  async oidcLogout(req: ExtendedRequest, res: Response): Promise<void> {
    const subject = toAuditSubject(req.auth?.session);
    if (
      await this.checkRateLimit(
        req,
        res,
        "oidc",
        "auth.oidc.session.delete",
        subject,
      )
    ) {
      await oidcLogout(req, res);
    }
  }
}

