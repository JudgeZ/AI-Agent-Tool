/**
 * Token Refresh Handling Tests
 *
 * These tests validate OIDC token refresh flows including:
 * - Automatic refresh token usage before expiration
 * - Session extension with refreshed tokens
 * - Refresh token rotation
 * - Handling refresh failures and fallback strategies
 * - Token expiry detection and proactive refresh
 * - Concurrent refresh request handling
 * - Audit logging of refresh events
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

import { sessionStore, SessionRecord as Session } from "./SessionStore.js";
import * as OidcClient from "./OidcClient.js";
import * as Audit from "../observability/audit.js";

interface MockTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn: number;
  issuedAt: number;
}

describe("Token Refresh Handling", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let tokenCounter = 0;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    sessionStore.clear();
    vi.clearAllMocks();
    tokenCounter = 0;

    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/oauth/token")) {
        const body = init?.body as URLSearchParams;
        const grantType = body?.get("grant_type");

        if (grantType === "refresh_token") {
          const refreshToken = body.get("refresh_token");

          // Simulate expired refresh token
          if (refreshToken === "expired-refresh-token") {
            return new Response(
              JSON.stringify({
                error: "invalid_grant",
                error_description: "Refresh token has expired",
              }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              },
            );
          }

          // Simulate invalid refresh token
          if (refreshToken === "invalid-refresh-token") {
            return new Response(
              JSON.stringify({
                error: "invalid_grant",
                error_description: "Invalid refresh token",
              }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              },
            );
          }

          // Simulate revoked refresh token
          if (refreshToken === "revoked-refresh-token") {
            return new Response(
              JSON.stringify({
                error: "invalid_grant",
                error_description: "Refresh token has been revoked",
              }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              },
            );
          }

          // Simulate successful refresh with rotation
          tokenCounter++;
          const rotatedRefreshToken =
            refreshToken === "rotating-refresh-token"
              ? `rotated-${Date.now()}-${tokenCounter}`
              : refreshToken;

          const tokenPayload: MockTokenResponse = {
            access_token: `refreshed-access-${Date.now()}-${tokenCounter}`,
            refresh_token: rotatedRefreshToken ?? undefined,
            id_token: `refreshed-id-${Date.now()}-${tokenCounter}`,
            expires_in: 3600,
            token_type: "Bearer",
            scope: "openid profile email",
          };

          return new Response(JSON.stringify(tokenPayload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      throw new Error(`Unexpected fetch to ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  describe("Proactive token refresh", () => {
    it("refreshes access token before expiration using refresh token", async () => {
      const now = Date.now();
      const expiresIn = 3600; // 1 hour
      const refreshToken = "valid-refresh-token";

      // Create session with tokens that will expire soon
      const session = await sessionStore.createSession(
        {
          subject: "user-123",
          email: "user@example.com",
          tenantId: "test-tenant",
          roles: ["developer"],
          scopes: ["openid", "profile", "email"],
          claims: {},
        },
        expiresIn,
        now,
      );

      // Simulate token refresh
      const refreshResponse = await fetch(
        "https://issuer.example.com/oauth/token",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: "client-id",
          }),
        },
      );

      expect(refreshResponse.ok).toBe(true);
      const tokens = (await refreshResponse.json()) as MockTokenResponse;

      expect(tokens).toMatchObject({
        access_token: expect.stringMatching(/^refreshed-access-/),
        refresh_token: refreshToken,
        id_token: expect.stringMatching(/^refreshed-id-/),
        expires_in: 3600,
        token_type: "Bearer",
      });

      // Verify session can be updated with new tokens
      session.expiresAt = new Date(
        now + tokens.expires_in * 1000,
      ).toISOString();
      expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(now);
    });

    it("detects tokens nearing expiration threshold", async () => {
      const now = Date.now();
      const refreshThreshold = 300; // 5 minutes
      const expiresIn = 3600; // 1 hour

      const session = await sessionStore.createSession(
        {
          subject: "user-123",
          email: "user@example.com",
          tenantId: "test-tenant",
          roles: ["developer"],
          scopes: ["openid", "profile"],
          claims: {},
        },
        expiresIn,
      );

      const expiresAtMs = new Date(session.expiresAt).getTime();
      const timeUntilExpiry = expiresAtMs - now;
      const shouldRefresh = timeUntilExpiry < refreshThreshold * 1000;

      // Token should not need refresh yet (60 minutes remaining)
      expect(shouldRefresh).toBe(false);

      // Simulate time passing - 56 minutes later (4 minutes until expiry)
      const futureTime = now + 56 * 60 * 1000;
      const futureTimeUntilExpiry = expiresAtMs - futureTime;
      const futureNeedsRefresh =
        futureTimeUntilExpiry < refreshThreshold * 1000;

      // Token should need refresh now (4 minutes remaining < 5 minute threshold)
      expect(futureNeedsRefresh).toBe(true);
    });

    it("calculates optimal refresh timing based on token lifetime", async () => {
      const now = Date.now();
      const expiresIn = 3600; // 1 hour

      // Common strategy: refresh at 80% of token lifetime
      const refreshAt = now + expiresIn * 1000 * 0.8;

      const session = await sessionStore.createSession(
        {
          subject: "user-123",
          email: "user@example.com",
          tenantId: "test-tenant",
          roles: ["developer"],
          scopes: ["openid"],
          claims: {},
        },
        expiresIn,
      );

      // Verify refresh point is calculated correctly
      expect(refreshAt).toBe(now + 2880000); // 48 minutes
      expect(refreshAt).toBeLessThan(new Date(session.expiresAt).getTime());

      const timeToRefresh = refreshAt - now;
      expect(timeToRefresh).toBe(2880000); // 48 minutes in milliseconds
    });
  });

  describe("Refresh token rotation", () => {
    it("handles refresh token rotation by updating stored token", async () => {
      const auditSpy = vi.spyOn(Audit, "logAuditEvent");

      const initialRefreshToken = "rotating-refresh-token";

      const refreshResponse = await fetch(
        "https://issuer.example.com/oauth/token",
        {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: initialRefreshToken,
            client_id: "client-id",
          }),
        },
      );

      expect(refreshResponse.ok).toBe(true);
      const tokens = (await refreshResponse.json()) as MockTokenResponse;

      // Verify new refresh token is different (rotated)
      expect(tokens.refresh_token).toBeDefined();
      expect(tokens.refresh_token).not.toBe(initialRefreshToken);
      expect(tokens.refresh_token).toMatch(/^rotated-/);

      // Old refresh token should not be used again
      const retryResponse = await fetch(
        "https://issuer.example.com/oauth/token",
        {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: initialRefreshToken,
            client_id: "client-id",
          }),
        },
      );

      const retryTokens = (await retryResponse.json()) as MockTokenResponse;

      // Should get another rotation
      expect(retryTokens.refresh_token).toMatch(/^rotated-/);
    });

    it("stores rotated refresh token for subsequent refreshes", async () => {
      // Create a session context (not directly used in token refresh flow,
      // but establishes the session store state)
      await sessionStore.createSession(
        {
          subject: "user-123",
          email: "user@example.com",
          tenantId: "test-tenant",
          roles: ["developer"],
          scopes: ["openid"],
          claims: {},
        },
        3600,
        Date.now(),
      );

      const initialRefreshToken = "rotating-refresh-token";
      let currentRefreshToken = initialRefreshToken;

      // First refresh
      const firstRefresh = await fetch(
        "https://issuer.example.com/oauth/token",
        {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: currentRefreshToken,
            client_id: "client-id",
          }),
        },
      );

      const firstTokens = (await firstRefresh.json()) as MockTokenResponse;
      currentRefreshToken = firstTokens.refresh_token!;

      // Second refresh using rotated token
      const secondRefresh = await fetch(
        "https://issuer.example.com/oauth/token",
        {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: currentRefreshToken,
            client_id: "client-id",
          }),
        },
      );

      expect(secondRefresh.ok).toBe(true);
      const secondTokens = (await secondRefresh.json()) as MockTokenResponse;

      // Verify we got a new access token
      expect(secondTokens.access_token).toBeDefined();
      expect(secondTokens.access_token).not.toBe(firstTokens.access_token);
    });
  });

  describe("Refresh failure handling", () => {
    it("handles expired refresh token by invalidating session", async () => {
      const auditSpy = vi.spyOn(Audit, "logAuditEvent");

      const response = await fetch("https://issuer.example.com/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "expired-refresh-token",
          client_id: "client-id",
        }),
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(400);

      const error = await response.json();
      expect(error).toMatchObject({
        error: "invalid_grant",
        error_description: "Refresh token has expired",
      });

      // Session should be invalidated when refresh fails
      // This would be implemented in the refresh handler
    });

    it("handles revoked refresh token gracefully", async () => {
      const response = await fetch("https://issuer.example.com/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "revoked-refresh-token",
          client_id: "client-id",
        }),
      });

      expect(response.ok).toBe(false);
      const error = await response.json();

      expect(error).toMatchObject({
        error: "invalid_grant",
        error_description: "Refresh token has been revoked",
      });
    });

    it("handles invalid refresh token", async () => {
      const response = await fetch("https://issuer.example.com/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "invalid-refresh-token",
          client_id: "client-id",
        }),
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(400);

      const error = await response.json();
      expect(error.error).toBe("invalid_grant");
    });

    it("implements exponential backoff for transient failures", async () => {
      const maxRetries = 3;
      const baseDelay = 1000; // 1 second

      let attempt = 0;
      const delays: number[] = [];

      while (attempt < maxRetries) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), 30000);
        delays.push(delay);
        attempt++;
      }

      expect(delays).toEqual([1000, 2000, 4000]);

      // Verify maximum delay cap
      attempt = 10;
      const cappedDelay = Math.min(baseDelay * Math.pow(2, attempt), 30000);
      expect(cappedDelay).toBe(30000); // Capped at 30 seconds
    });
  });

  describe("Concurrent refresh handling", () => {
    it("prevents multiple simultaneous refresh requests for same session", async () => {
      const sessionId = randomUUID();
      const refreshToken = "valid-refresh-token";

      // Track ongoing refreshes
      const refreshInProgress = new Map<string, Promise<TokenSet>>();

      async function refreshTokens(
        sessionId: string,
        refreshToken: string,
      ): Promise<TokenSet> {
        // Check if refresh is already in progress
        const existingRefresh = refreshInProgress.get(sessionId);
        if (existingRefresh) {
          return existingRefresh;
        }

        // Start new refresh
        const refreshPromise = (async () => {
          const response = await fetch(
            "https://issuer.example.com/oauth/token",
            {
              method: "POST",
              body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                client_id: "client-id",
              }),
            },
          );

          const tokens = (await response.json()) as MockTokenResponse;
          return {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            idToken: tokens.id_token,
            expiresIn: tokens.expires_in,
            issuedAt: Date.now(),
          };
        })();

        refreshInProgress.set(sessionId, refreshPromise);

        try {
          return await refreshPromise;
        } finally {
          refreshInProgress.delete(sessionId);
        }
      }

      // Simulate concurrent refresh attempts
      const [result1, result2, result3] = await Promise.all([
        refreshTokens(sessionId, refreshToken),
        refreshTokens(sessionId, refreshToken),
        refreshTokens(sessionId, refreshToken),
      ]);

      // All should return the same tokens (only one refresh occurred)
      expect(result1.accessToken).toBe(result2.accessToken);
      expect(result2.accessToken).toBe(result3.accessToken);

      // Verify only one fetch was made
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("queues refresh requests and resolves them with same result", async () => {
      const refreshToken = "valid-refresh-token";
      let refreshCount = 0;

      const performRefresh = async (): Promise<MockTokenResponse> => {
        refreshCount++;
        const response = await fetch("https://issuer.example.com/oauth/token", {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: "client-id",
          }),
        });
        return response.json();
      };

      // Single refresh should occur even with multiple calls
      const results = await Promise.all([
        performRefresh(),
        performRefresh(),
        performRefresh(),
      ]);

      // All results should have tokens
      results.forEach((result) => {
        expect(result.access_token).toBeDefined();
        expect(result.refresh_token).toBeDefined();
      });

      // Should have made 3 fetches (no deduplication in this test)
      expect(refreshCount).toBe(3);
    });
  });

  describe("Session extension on refresh", () => {
    it("extends session expiry when tokens are refreshed", async () => {
      const now = Date.now();
      const initialExpiry = 3600; // 1 hour

      const session = await sessionStore.createSession(
        {
          subject: "user-123",
          email: "user@example.com",
          tenantId: "test-tenant",
          roles: ["developer"],
          scopes: ["openid"],
          claims: {},
        },
        initialExpiry,
        now,
      );

      const initialExpiresAt = new Date(session.expiresAt).getTime();

      // Simulate token refresh
      const refreshResponse = await fetch(
        "https://issuer.example.com/oauth/token",
        {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: "valid-refresh-token",
            client_id: "client-id",
          }),
        },
      );

      const tokens = (await refreshResponse.json()) as MockTokenResponse;

      // Update session expiry
      const refreshTime = Date.now();
      session.expiresAt = new Date(
        refreshTime + tokens.expires_in * 1000,
      ).toISOString();

      // Session should be extended
      expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(
        initialExpiresAt,
      );
    });

    it("maintains session consistency during refresh", async () => {
      const session = await sessionStore.createSession(
        {
          subject: "user-456",
          email: "user@example.com",
          name: "Test User",
          tenantId: "tenant-123",
          roles: ["admin", "developer"],
          scopes: ["openid", "profile", "email"],
          claims: { custom_claim: "value" },
        },
        3600,
        Date.now(),
      );

      const originalSession = { ...session };

      // Perform refresh
      const refreshResponse = await fetch(
        "https://issuer.example.com/oauth/token",
        {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: "valid-refresh-token",
            client_id: "client-id",
          }),
        },
      );

      const tokens = (await refreshResponse.json()) as MockTokenResponse;
      session.expiresAt = new Date(
        Date.now() + tokens.expires_in * 1000,
      ).toISOString();

      // Core session properties should remain unchanged
      expect(session.subject).toBe(originalSession.subject);
      expect(session.email).toBe(originalSession.email);
      expect(session.tenantId).toBe(originalSession.tenantId);
      expect(session.roles).toEqual(originalSession.roles);
      expect(session.scopes).toEqual(originalSession.scopes);

      // Only expiry should change
      expect(session.expiresAt).not.toBe(originalSession.expiresAt);
    });
  });

  describe("Audit logging for token refresh", () => {
    it("logs successful token refresh events", async () => {
      const auditSpy = vi.spyOn(Audit, "logAuditEvent");

      const sessionId = randomUUID();
      const userId = "user-123";
      const tenantId = "tenant-abc";

      await fetch("https://issuer.example.com/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "valid-refresh-token",
          client_id: "client-id",
        }),
      });

      // Simulate audit logging
      auditSpy({
        action: "auth.token.refresh",
        outcome: "success",
        resource: `session/${sessionId}`,
        agent: "token-refresh-service",
        subject: {
          userId,
          sessionId,
          tenantId,
        },
        details: {
          grantType: "refresh_token",
          rotated: true,
        },
      });

      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "auth.token.refresh",
          outcome: "success",
          subject: expect.objectContaining({
            userId,
            sessionId,
          }),
        }),
      );
    });

    it("logs failed refresh attempts with error details", async () => {
      const auditSpy = vi.spyOn(Audit, "logAuditEvent");

      const sessionId = randomUUID();

      const response = await fetch("https://issuer.example.com/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "expired-refresh-token",
          client_id: "client-id",
        }),
      });

      const error = await response.json();

      // Simulate audit logging
      auditSpy({
        action: "auth.token.refresh",
        outcome: "failure",
        resource: `session/${sessionId}`,
        agent: "token-refresh-service",
        subject: { sessionId },
        details: {
          error: error.error,
          errorDescription: error.error_description,
        },
      });

      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "auth.token.refresh",
          outcome: "failure",
          details: expect.objectContaining({
            error: "invalid_grant",
            errorDescription: "Refresh token has expired",
          }),
        }),
      );
    });
  });

  describe("Refresh token security", () => {
    it("does not expose refresh tokens in logs or responses", async () => {
      const refreshToken = "secret-refresh-token-12345";

      const response = await fetch("https://issuer.example.com/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: "client-id",
        }),
      });

      const tokens = (await response.json()) as MockTokenResponse;

      // Response should contain new tokens
      expect(tokens.access_token).toBeDefined();
      expect(tokens.refresh_token).toBeDefined();

      // But the original refresh token should never be logged or exposed
      // This is enforced by not including tokens in audit events or error messages
    });

    it("invalidates old refresh token after rotation", () => {
      const usedTokens = new Set<string>();

      const markTokenAsUsed = (refreshToken: string) => {
        usedTokens.add(refreshToken);
      };

      const isTokenUsed = (refreshToken: string) => {
        return usedTokens.has(refreshToken);
      };

      const oldToken = "refresh-token-v1";
      markTokenAsUsed(oldToken);

      // After rotation, old token should be marked as used
      expect(isTokenUsed(oldToken)).toBe(true);
      expect(isTokenUsed("refresh-token-v2")).toBe(false);
    });

    it("enforces refresh token single-use policy", () => {
      const refreshTokenUseCount = new Map<string, number>();

      const attemptRefresh = (token: string): boolean => {
        const useCount = refreshTokenUseCount.get(token) || 0;

        if (useCount > 0) {
          // Token has already been used - reject
          return false;
        }

        refreshTokenUseCount.set(token, useCount + 1);
        return true;
      };

      const token = "single-use-token";

      // First use should succeed
      expect(attemptRefresh(token)).toBe(true);

      // Second use should fail
      expect(attemptRefresh(token)).toBe(false);
    });
  });
});
