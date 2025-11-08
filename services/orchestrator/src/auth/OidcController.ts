import type { Request, Response } from "express";

import { loadConfig } from "../config.js";
import {
  fetchOidcMetadata,
  exchangeCodeForTokens,
  verifyIdToken,
} from "./OidcClient.js";
import { sessionStore } from "./SessionStore.js";
import { logAuditEvent, type AuditSubject } from "../observability/audit.js";

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

function extractSessionId(
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
  const parts = cookieHeader.split(";");
  for (const part of parts) {
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

export async function getOidcConfiguration(req: Request, res: Response) {
  const config = loadConfig();
  const oidc = config.auth.oidc;
  if (!oidc.enabled) {
    res.status(404).json({ error: "oidc not enabled" });
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
    res.status(502).json({ error: message });
  }
}

export async function handleOidcCallback(req: Request, res: Response) {
  const config = loadConfig();
  const oidc = config.auth.oidc;
  if (!oidc.enabled) {
    res.status(404).json({ error: "oidc not enabled" });
    return;
  }

  const {
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    state,
  } = req.body ?? {};
  if (typeof code !== "string" || code.length === 0) {
    logAuditEvent({
      action: "auth.oidc.callback",
      outcome: "failure",
      requestId: req.header("x-request-id") ?? undefined,
      traceId: req.header("x-trace-id") ?? undefined,
      resource: "auth.session",
      details: { reason: "code missing" },
    });
    res.status(400).json({ error: "code is required" });
    return;
  }
  if (typeof codeVerifier !== "string" || codeVerifier.length < 43) {
    logAuditEvent({
      action: "auth.oidc.callback",
      outcome: "failure",
      requestId: req.header("x-request-id") ?? undefined,
      traceId: req.header("x-trace-id") ?? undefined,
      resource: "auth.session",
      details: { reason: "code_verifier invalid" },
    });
    res.status(400).json({ error: "code_verifier is required" });
    return;
  }
  if (typeof redirectUri !== "string" || redirectUri !== oidc.redirectUri) {
    logAuditEvent({
      action: "auth.oidc.callback",
      outcome: "failure",
      requestId: req.header("x-request-id") ?? undefined,
      traceId: req.header("x-trace-id") ?? undefined,
      resource: "auth.session",
      details: { reason: "redirect_uri mismatch", redirectUri },
    });
    res.status(400).json({ error: "redirect_uri mismatch" });
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
      if (
        typeof state !== "string" ||
        state.length === 0 ||
        state !== stateCookie
      ) {
        logAuditEvent({
          action: "auth.oidc.callback",
          outcome: "failure",
          requestId: req.header("x-request-id") ?? undefined,
          traceId: req.header("x-trace-id") ?? undefined,
          resource: "auth.session",
          details: { reason: "state verification failed" },
        });
        res.status(400).json({ error: "state verification failed" });
        return;
      }
    }
  } catch {
    // If cookie parsing fails, proceed; token verification below still protects integrity
  }

  try {
    const metadata = await fetchOidcMetadata(oidc);
    const tokenResponse = await exchangeCodeForTokens(
      oidc,
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
      res.status(502).json({ error: "id_token missing in response" });
      return;
    }
    const verification = await verifyIdToken(
      oidc,
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
      res.status(502).json({ error: "id_token missing subject" });
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
      res.status(502).json({ error: "token expiry too soon" });
      return;
    }

    const tenantId =
      (typeof oidc.tenantClaim === "string" && oidc.tenantClaim.length > 0
        ? payload[oidc.tenantClaim]
        : undefined) || undefined;
    const tenant =
      typeof tenantId === "string" && tenantId.length > 0
        ? tenantId
        : undefined;
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
        tokens: {
          idToken: tokenResponse.id_token,
          accessToken:
            typeof tokenResponse.access_token === "string"
              ? tokenResponse.access_token
              : undefined,
          refreshToken:
            typeof tokenResponse.refresh_token === "string"
              ? tokenResponse.refresh_token
              : undefined,
        },
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
    res.status(status).json({ error: message });
  }
}

export async function getSession(req: Request, res: Response) {
  const config = loadConfig();
  const cookieName = config.auth.oidc.session.cookieName;
  const sessionId = extractSessionId(req, cookieName);
  if (!sessionId) {
    res.status(401).json({ error: "session not found" });
    return;
  }
  sessionStore.cleanupExpired();
  const session = sessionStore.getSession(sessionId);
  if (!session) {
    res.status(401).json({ error: "session expired" });
    return;
  }
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
  const sessionId = extractSessionId(req, cookieName);
  if (sessionId) {
    const session = sessionStore.getSession(sessionId);
    sessionStore.revokeSession(sessionId);
    logAuditEvent({
      action: "auth.logout",
      outcome: "success",
      requestId: req.header("x-request-id") ?? undefined,
      traceId: req.header("x-trace-id") ?? undefined,
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
    });
  }
  const cookieOptions = computeCookieOptions(
    0,
    determineSecureCookieFlag(config.server.tls.enabled),
  );
  res.clearCookie(cookieName, { ...cookieOptions, maxAge: 0 });
  res.status(204).end();
}
