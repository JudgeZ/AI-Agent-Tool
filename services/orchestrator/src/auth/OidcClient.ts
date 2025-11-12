import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyResult } from "jose";
import { loadConfig, type OidcAuthConfig } from "../config.js";
import { ensureEgressAllowed } from "../network/EgressGuard.js";

export type OidcMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
};

export type OidcTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  [key: string]: unknown;
};

const METADATA_TTL_MS = 15 * 60 * 1000;

const metadataCache = new Map<string, { metadata: OidcMetadata; expiresAt: number }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function cacheMetadata(issuer: string, metadata: OidcMetadata): void {
  metadataCache.set(issuer, { metadata, expiresAt: Date.now() + METADATA_TTL_MS });
}

export async function fetchOidcMetadata(config: OidcAuthConfig): Promise<OidcMetadata> {
  const cached = metadataCache.get(config.issuer);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.metadata;
  }
  const wellKnownUrl = `${config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  ensureEgressAllowed(wellKnownUrl, {
    action: "oidc.discovery",
    metadata: { issuer: config.issuer },
  });
  const response = await fetch(wellKnownUrl, {
    method: "GET",
    headers: { Accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`OIDC discovery failed with status ${response.status}`);
  }
  const payload = (await response.json()) as Partial<OidcMetadata>;
  if (!payload.issuer || !payload.authorization_endpoint || !payload.token_endpoint || !payload.jwks_uri) {
    throw new Error("OIDC discovery response missing required fields");
  }
  const metadata: OidcMetadata = {
    issuer: payload.issuer,
    authorization_endpoint: payload.authorization_endpoint,
    token_endpoint: payload.token_endpoint,
    jwks_uri: payload.jwks_uri,
    end_session_endpoint: payload.end_session_endpoint
  };
  cacheMetadata(config.issuer, metadata);
  return metadata;
}

function getRemoteJwks(metadata: OidcMetadata) {
  const existing = jwksCache.get(metadata.jwks_uri);
  if (existing) {
    return existing;
  }
  ensureEgressAllowed(metadata.jwks_uri, {
    action: "oidc.jwks",
    metadata: { issuer: metadata.issuer },
  });
  const remote = createRemoteJWKSet(new URL(metadata.jwks_uri));
  jwksCache.set(metadata.jwks_uri, remote);
  return remote;
}

export async function exchangeCodeForTokens(
  config: OidcAuthConfig,
  metadata: OidcMetadata,
  code: string,
  codeVerifier: string,
  timeoutMs?: number
): Promise<OidcTokenResponse> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: config.redirectUri,
    client_id: config.clientId
  });
  if (config.clientSecret) {
    params.set("client_secret", config.clientSecret);
  }

  const controller = new AbortController();
  let timeoutHandle: NodeJS.Timeout | undefined;
  if (timeoutMs && Number.isFinite(timeoutMs)) {
    timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    timeoutHandle.unref?.();
  }

  try {
    ensureEgressAllowed(metadata.token_endpoint, {
      action: "oidc.token",
      metadata: { issuer: metadata.issuer },
    });
    const response = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `OIDC token endpoint returned ${response.status}`);
    }
    return (await response.json()) as OidcTokenResponse;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`OIDC token endpoint timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export async function verifyIdToken(
  config: OidcAuthConfig,
  metadata: OidcMetadata,
  idToken: string
): Promise<JWTVerifyResult<JWTPayload>> {
  const jwks = getRemoteJwks(metadata);
  const audience = config.audience ?? config.clientId;
  return jwtVerify(idToken, jwks, {
    issuer: metadata.issuer,
    audience,
    clockTolerance: "5s"
  });
}

export async function loadOidcConfiguration() {
  const config = loadConfig();
  return config.auth.oidc;
}
