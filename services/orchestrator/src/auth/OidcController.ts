import type { Request, Response } from "express";

import { loadConfig } from "../config.js";
import {
  fetchOidcMetadata,
  exchangeCodeForTokens,
  verifyIdToken,
} from "./OidcClient.js";
import { sessionStore } from "./SessionStore.js";
import { logAuditEvent, type AuditSubject } from "../observability/audit.js";
import { OidcCallbackSchema, formatValidationIssues } from "../http/validation.js";
import { respondWithError, respondWithValidationError } from "../http/errors.js";
import { extractSessionId } from "./sessionValidation.js";

const MINIMUM_SESSION_EXPIRY_BUFFER_MS = 5_000;

function parseTokensScope(
  scope: string | undefined,
  configScopes: string[],
): string[] {
  if (!scope) {
    return configScopes;
  }
  const combined = new Set<string>();
  for (const item of configScopes) {
    combined.add(item);
  }
  for (const part of scope.split(/[\s,]+/)) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      combined.add(trimmed);
    }
  }
  return Array.from(combined);
}

function determineSecureCookieFlag(tlsEnabled: boolean): boolean {
  if (process.env.COOKIE_SECURE === "true") {
    return true;
  }
  if (process.env.COOKIE_SECURE === "false") {
    return false;
  }
  if (tlsEnabled) {
    return true;
  }
  return process.env.NODE_ENV !== "development";
}

function computeCookieOptions(maxAgeSeconds: number, secure: boolean) {
  const normalizedSeconds = Number.isFinite(maxAgeSeconds)
    ? Math.max(0, Math.floor(maxAgeSeconds))
    : 0;
  const maxAgeMs = normalizedSeconds * 1000;
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeMs,
  };
}

function extractRolesFromClaimValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : undefined))
      .filter((entry): entry is string => !!entry && entry.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

function resolveClaimValue(
  payload: Record<string, unknown>,
  claim?: string,
): unknown {
  if (!claim) {
    return undefined;
  }
  const segments = claim
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  let current: unknown = payload;
  for (const segment of segments) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    if (segment === "__proto__" || segment === "prototype" || segment === "constructor") {
      return undefined;
    }
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) {
      return undefined;
    }
    current = record[segment];
  }
  return current;
}

function normalizeRoles(roles: string[]): string[] {
  return Array.from(
    new Set(roles.map((role) => role.trim()).filter((role) => role.length > 0)),
  ).sort((a, b) => a.localeCompare(b));
}

function extractRoles(
  payload: Record<string, unknown>,
  configRoles: { claim?: string; fallback: string[] },
): string[] {
  const result: string[] = [];
  result.push(...configRoles.fallback);
  const claimValue = resolveClaimValue(payload, configRoles.claim);
  if (claimValue !== undefined) {
    result.push(...extractRolesFromClaimValue(claimValue));
  }
  return normalizeRoles(result);
}

function extractTenantId(
  payload: Record<string, unknown>,
  tenantClaim?: string,
): string | undefined {
  const claimValue = resolveClaimValue(payload, tenantClaim);
  if (claimValue === undefined) {
    return undefined;
  }
  const normalized = extractRolesFromClaimValue(claimValue);
  return normalized.length > 0 ? normalized[0] : undefined;
}

export async function getOidcConfiguration(req: Request, res: Response) {
  const config = loadConfig();
  const oidc = config.auth.oidc;
  if (!oidc.enabled) {
    respondWithError(res, 404, {
      code: "not_found",
      message: "oidc not enabled",
    });
    return;
  }
  try {
    const metadata = await fetchOidcMetadata(oidc);
    res.json({
      issuer: metadata.issuer,
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
      jwksUri: metadata.jwks_uri,
      logoutEndpoint: oidc.logoutUrl ?? metadata.end_session_endpoint ?? null,
      clientId: oidc.clientId,
      redirectUri: oidc.redirectUri,
      scopes: oidc.scopes,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "failed to load oidc metadata";
    respondWithError(res, 502, {
      code: "upstream_error",
      message,
    });
  }
}

export async function handleOidcCallback(req: Request, res: Response) {
  const config = loadConfig();
  const oidc = config.auth.oidc;
  if (!oidc.enabled) {
    respondWithError(res, 404, {
      code: "not_found",
      message: "oidc not enabled",
    });
    return;
  }

  const parsedBody = OidcCallbackSchema.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    const details = formatValidationIssues(parsedBody.error.issues);
    logAuditEvent({
      action: "auth.oidc.callback",
      outcome: "failure",
      requestId: req.header("x-request-id") ?? undefined,
      traceId: req.header("x-trace-id") ?? undefined,
      resource: "auth.session",
      details: { reason: details[0]?.message ?? "invalid request" },
    });
    respondWithValidationError(res, details);
    return;
  }
  const { code, codeVerifier, redirectUri, state, clientId } = parsedBody.data;

  const effectiveOidc =
    typeof clientId === "string" && clientId.length > 0
      ? { ...oidc, clientId }
      : oidc;

  if (redirectUri !== oidc.redirectUri) {
    logAuditEvent({
      action: "auth.oidc.callback",
      outcome: "failure",
      requestId: req.header("x-request-id") ?? undefined,
      traceId: req.header("x-trace-id") ?? undefined,
      resource: "auth.session",
      details: { reason: "redirect_uri mismatch", redirectUri },
    });
    respondWithValidationError(res, [
      { path: "redirect_uri", message: "redirect_uri mismatch" },
    ]);
    return;
  }

  // Best-effort CSRF protection: if a state cookie is present, require it to match provided state
  // This remains backwards-compatible when the client has not yet implemented state cookies
  try {
    const cookieHeader = req.headers.cookie;
    let stateCookie: string | undefined;
    if (cookieHeader) {
      for (const part of cookieHeader.split(";")) {
        const [rawName, ...rest] = part.split("=");
        if (!rawName) continue;
        const name = rawName.trim();
        if (
          name !==
          (process.env.OIDC_STATE_COOKIE_NAME?.trim() || "oss_oidc_state")
        )
          continue;
        const value = rest.join("=").trim();
        if (!value) continue;
        try {
          stateCookie = decodeURIComponent(value);
        } catch {
          stateCookie = value;
        }
        break;
      }
    }
    if (stateCookie !== undefined) {
      if (state === undefined || state !== stateCookie) {
        logAuditEvent({
          action: "auth.oidc.callback",
          outcome: "failure",
          requestId: req.header("x-request-id") ?? undefined,
          traceId: req.header("x-trace-id") ?? undefined,
          resource: "auth.session",
          details: { reason: "state verification failed" },
        });
        respondWithValidationError(res, [
          { path: "state", message: "state verification failed" },
        ]);
        return;
      }
    }
  } catch {
    // If cookie parsing fails, proceed; token verification below still protects integrity
  }

  try {
    const metadata = await fetchOidcMetadata(effectiveOidc);
    const tokenResponse = await exchangeCodeForTokens(
      effectiveOidc,
      metadata,
      code,
      codeVerifier,
      config.tooling.defaultTimeoutMs,
    );
    if (
      typeof tokenResponse.id_token !== "string" ||
      tokenResponse.id_token.length === 0
    ) {
      logAuditEvent({
        action: "auth.oidc.callback",
        outcome: "failure",
        requestId: req.header("x-request-id") ?? undefined,
        traceId: req.header("x-trace-id") ?? undefined,
        resource: "auth.session",
        details: { reason: "id_token missing" },
      });
      respondWithError(res, 502, {
        code: "upstream_error",
        message: "id_token missing in response",
      });
      return;
    }
    const verification = await verifyIdToken(
      effectiveOidc,
      metadata,
      tokenResponse.id_token,
    );
    const payload = verification.payload;
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      logAuditEvent({
        action: "auth.oidc.callback",
        outcome: "failure",
        requestId: req.header("x-request-id") ?? undefined,
        traceId: req.header("x-trace-id") ?? undefined,
        resource: "auth.session",
        details: { reason: "id_token subject missing" },
      });
      respondWithError(res, 502, {
        code: "upstream_error",
        message: "id_token missing subject",
      });
      return;
    }

    const now = Date.now();
    const ttlSeconds = oidc.session.ttlSeconds;
    const ttlMs = ttlSeconds * 1000;
    const accessTokenExpiry =
      typeof tokenResponse.expires_in === "number"
        ? now + Math.max(1, tokenResponse.expires_in) * 1000
        : Number.POSITIVE_INFINITY;
    const idTokenExpiry =
      typeof payload.exp === "number"
        ? payload.exp * 1000
        : Number.POSITIVE_INFINITY;
    const targetExpiry = Math.min(
      now + ttlMs,
      accessTokenExpiry,
      idTokenExpiry,
    );

    const minimumAllowedExpiry = now + MINIMUM_SESSION_EXPIRY_BUFFER_MS;
    if (!Number.isFinite(targetExpiry) || targetExpiry <= minimumAllowedExpiry) {
      logAuditEvent({
        action: "auth.oidc.callback",
        outcome: "failure",
        requestId: req.header("x-request-id") ?? undefined,
        traceId: req.header("x-trace-id") ?? undefined,
        resource: "auth.session",
        details: {
          reason: "token expiry too soon",
          expiresAt: Number.isFinite(targetExpiry)
            ? new Date(targetExpiry).toISOString()
            : null,
          minimumAllowedExpiry: new Date(minimumAllowedExpiry).toISOString(),
        },
      });
      respondWithError(res, 502, {
        code: "upstream_error",
        message: "token expiry too soon",
      });
      return;
    }

    const tenant = extractTenantId(
      payload as Record<string, unknown>,
      typeof oidc.tenantClaim === "string" ? oidc.tenantClaim : undefined,
    );
    const email = typeof payload.email === "string" ? payload.email : undefined;
    const name = typeof payload.name === "string" ? payload.name : undefined;
    const roles = extractRoles(payload as Record<string, unknown>, oidc.roles);
    const scopes = parseTokensScope(tokenResponse.scope, oidc.scopes);

    const session = sessionStore.createSession(
      {
        subject: payload.sub,
        email,
        name,
        tenantId: tenant,
        roles,
        scopes,
        claims: { ...payload },
        // Tokens are intentionally omitted from the session payload to reduce
        // in-memory secret exposure; sessions retain only identity metadata.
      },
      ttlSeconds,
      targetExpiry,
    );

    const cookieName = oidc.session.cookieName;
    const expiresInSeconds = Math.max(
      1,
      Math.floor((targetExpiry - now) / 1000),
    );
    const secureCookies = determineSecureCookieFlag(config.server.tls.enabled);
    if (config.runMode === "enterprise" && !secureCookies) {
      respondWithError(res, 500, {
        code: "configuration_error",
        message: "secure cookies must be enabled when run mode is enterprise",
      });
      return;
    }
    res.cookie(
      cookieName,
      session.id,
      computeCookieOptions(expiresInSeconds, secureCookies),
    );

    res.json({
      sessionId: session.id,
      subject: session.subject,
      email: session.email ?? null,
      name: session.name ?? null,
      tenantId: session.tenantId ?? null,
      roles: session.roles,
      scopes: session.scopes,
      expiresAt: session.expiresAt,
      logoutUrl: oidc.logoutUrl ?? metadata.end_session_endpoint ?? null,
    });
    const auditSubject: AuditSubject = {
      sessionId: session.id,
      userId: session.subject,
      tenantId: session.tenantId ?? undefined,
      email: session.email ?? null,
      name: session.name ?? null,
      roles: session.roles.length > 0 ? [...session.roles] : undefined,
      scopes: session.scopes.length > 0 ? [...session.scopes] : undefined,
    };
    logAuditEvent({
      action: "auth.oidc.callback",
      outcome: "success",
      requestId: req.header("x-request-id") ?? undefined,
      traceId: req.header("x-trace-id") ?? undefined,
      resource: "auth.session",
      subject: auditSubject,
      details: { tenantId: session.tenantId ?? undefined, provider: "oidc" },
    });
  } catch (error) {
    const status =
      error instanceof Error && error.message.includes("timed out") ? 504 : 502;
    const message =
      error instanceof Error
        ? error.message
        : "failed to process oidc callback";
    logAuditEvent({
      action: "auth.oidc.callback",
      outcome: "failure",
      requestId: req.header("x-request-id") ?? undefined,
      traceId: req.header("x-trace-id") ?? undefined,
      resource: "auth.session",
      details: { error: message },
    });
    const code = status >= 500 ? "upstream_error" : "invalid_request";
    respondWithError(res, status, { code, message });
  }
}

export async function getSession(req: Request, res: Response) {
  const config = loadConfig();
  const cookieName = config.auth.oidc.session.cookieName;
  const sessionResult = extractSessionId(req, cookieName);
  const requestId = req.header("x-request-id") ?? undefined;
  const traceId = req.header("x-trace-id") ?? undefined;
  if (sessionResult.status === "invalid") {
    logAuditEvent({
      action: "auth.session.get",
      outcome: "failure",
      requestId,
      traceId,
      resource: "auth.session",
      details: {
        reason: "invalid session id",
        source: sessionResult.source,
        issues: sessionResult.issues,
      },
    });
    respondWithValidationError(res, sessionResult.issues);
    return;
  }
  if (sessionResult.status === "missing") {
    logAuditEvent({
      action: "auth.session.get",
      outcome: "failure",
      requestId,
      traceId,
      resource: "auth.session",
      details: { reason: "session cookie missing" },
    });
    respondWithError(res, 401, {
      code: "unauthorized",
      message: "session not found",
    });
    return;
  }
  sessionStore.cleanupExpired();
  const session = sessionStore.getSession(sessionResult.sessionId);
  if (!session) {
    logAuditEvent({
      action: "auth.session.get",
      outcome: "failure",
      requestId,
      traceId,
      resource: "auth.session",
      details: { reason: "session expired or missing" },
    });
    respondWithError(res, 401, {
      code: "unauthorized",
      message: "session expired",
    });
    return;
  }
  const auditSubject: AuditSubject = {
    sessionId: session.id,
    userId: session.subject,
    tenantId: session.tenantId ?? undefined,
    email: session.email ?? null,
    name: session.name ?? null,
    roles: session.roles.length > 0 ? [...session.roles] : undefined,
    scopes: session.scopes.length > 0 ? [...session.scopes] : undefined,
  };
  logAuditEvent({
    action: "auth.session.get",
    outcome: "success",
    requestId,
    traceId,
    resource: "auth.session",
    subject: auditSubject,
    details: { tenantId: session.tenantId ?? undefined },
  });
  res.json({
    session: {
      id: session.id,
      subject: session.subject,
      email: session.email ?? null,
      name: session.name ?? null,
      tenantId: session.tenantId ?? null,
      roles: session.roles,
      scopes: session.scopes,
      issuedAt: session.issuedAt,
      expiresAt: session.expiresAt,
    },
  });
}

export async function logout(req: Request, res: Response) {
  const config = loadConfig();
  const cookieName = config.auth.oidc.session.cookieName;
  const sessionResult = extractSessionId(req, cookieName);
  const requestId = req.header("x-request-id") ?? undefined;
  const traceId = req.header("x-trace-id") ?? undefined;
  const cookieOptions = computeCookieOptions(
    0,
    determineSecureCookieFlag(config.server.tls.enabled),
  );

  if (sessionResult.status === "invalid") {
    logAuditEvent({
      action: "auth.logout",
      outcome: "failure",
      requestId,
      traceId,
      resource: "auth.session",
      details: {
        reason: "invalid session id",
        source: sessionResult.source,
        issues: sessionResult.issues,
      },
    });
    res.clearCookie(cookieName, { ...cookieOptions, maxAge: 0 });
    respondWithValidationError(res, sessionResult.issues);
    return;
  }

  if (sessionResult.status === "valid") {
    const session = sessionStore.getSession(sessionResult.sessionId);
    sessionStore.revokeSession(sessionResult.sessionId);
    const outcome = session ? "success" : "failure";
    logAuditEvent({
      action: "auth.logout",
      outcome,
      requestId,
      traceId,
      resource: "auth.session",
      subject: session
        ? {
            sessionId: session.id,
            userId: session.subject,
            tenantId: session.tenantId ?? undefined,
            email: session.email ?? null,
            name: session.name ?? null,
          }
        : undefined,
      details: session
        ? { tenantId: session.tenantId ?? undefined }
        : { reason: "session not found" },
    });
  } else {
    logAuditEvent({
      action: "auth.logout",
      outcome: "failure",
      requestId,
      traceId,
      resource: "auth.session",
      details: { reason: "session cookie missing" },
    });
  }
  res.clearCookie(cookieName, { ...cookieOptions, maxAge: 0 });
  res.status(204).end();
}

