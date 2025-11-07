import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import type { OidcAuthConfig } from "../config.js";
import type { OidcTokenResponse } from "./OidcClient.js";

type FetchMock = ReturnType<typeof vi.fn>;

const joseMocks = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn()
}));

vi.mock("jose", () => ({
  createRemoteJWKSet: joseMocks.createRemoteJWKSet,
  jwtVerify: joseMocks.jwtVerify
}));

const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

async function resetEnvironment() {
  await vi.resetModules();
  vi.clearAllMocks();
  joseMocks.createRemoteJWKSet.mockReset();
  joseMocks.jwtVerify.mockReset();
  globalThis.fetch = originalFetch;
}

async function loadModule() {
  return import("./OidcClient.js");
}

function setupFetchMock(response: unknown): FetchMock {
  const mock = vi.fn(async () => response);
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

const baseConfig: OidcAuthConfig = {
  enabled: true,
  issuer: "https://issuer.example.com",
  clientId: "client-id",
  redirectBaseUrl: "https://app",
  redirectUri: "https://app/callback",
  scopes: ["openid"],
  roles: {
    fallback: [],
    mappings: {},
    tenantMappings: {}
  },
  session: {
    cookieName: "oidc",
    ttlSeconds: 3600
  }
};

const metadata = {
  issuer: "https://issuer.example.com",
  authorization_endpoint: "https://issuer.example.com/auth",
  token_endpoint: "https://issuer.example.com/token",
  jwks_uri: "https://issuer.example.com/jwks.json"
};

describe("fetchOidcMetadata", () => {
  beforeEach(async () => {
    await resetEnvironment();
  });

  it("caches metadata responses for repeated requests", async () => {
    const fetchMock = setupFetchMock({
      ok: true,
      json: async () => metadata
    });

    const { fetchOidcMetadata } = await loadModule();

    const first = await fetchOidcMetadata(baseConfig);
    const second = await fetchOidcMetadata(baseConfig);

    expect(first).toEqual(metadata);
    expect(second).toEqual(metadata);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://issuer.example.com/.well-known/openid-configuration",
      expect.objectContaining({ method: "GET" })
    );
  });
});

describe("exchangeCodeForTokens", () => {
  beforeEach(async () => {
    await resetEnvironment();
  });

  it.each([
    {
      name: "without client secret",
      config: baseConfig,
      expected: (body: URLSearchParams) => {
        expect(body.toString()).not.toContain("client_secret");
      }
    },
    {
      name: "with client secret",
      config: { ...baseConfig, clientSecret: "super-secret" },
      expected: (body: URLSearchParams) => {
        expect(body.get("client_secret")).toBe("super-secret");
      }
    }
  ])("includes expected form parameters $name", async ({ config, expected }) => {
    const tokenResponse: OidcTokenResponse = { access_token: "token" };
    const fetchMock = setupFetchMock({
      ok: true,
      json: async () => tokenResponse
    });

    const { exchangeCodeForTokens } = await loadModule();
    const result = await exchangeCodeForTokens(config, metadata, "auth-code", "verifier", 5000);

    expect(result).toEqual(tokenResponse);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, request] = fetchMock.mock.calls[0];
    expect(request?.method).toBe("POST");
    expect(request?.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
    const body = request?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("redirect_uri")).toBe(config.redirectUri);
    expect(body.get("client_id")).toBe(config.clientId);
    expect(body.get("code_verifier")).toBe("verifier");
    expected(body);
  });

  it("propagates timeout aborts as descriptive errors", async () => {
    await resetEnvironment();

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeDefined();
      const abortError = new Error("aborted");
      abortError.name = "AbortError";
      throw abortError;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { exchangeCodeForTokens } = await loadModule();

    await expect(
      exchangeCodeForTokens(baseConfig, metadata, "code", "verifier", 250)
    ).rejects.toThrow("OIDC token endpoint timed out after 250ms");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("verifyIdToken", () => {
  beforeEach(async () => {
    await resetEnvironment();
    joseMocks.jwtVerify.mockResolvedValue({} as never);
  });

  it("reuses the JWKS client for identical metadata", async () => {
    const jwksFn = vi.fn();
    joseMocks.createRemoteJWKSet.mockReturnValue(jwksFn);

    const { verifyIdToken } = await loadModule();

    await verifyIdToken(baseConfig, metadata, "token-one");
    await verifyIdToken(baseConfig, metadata, "token-two");

    expect(joseMocks.createRemoteJWKSet).toHaveBeenCalledTimes(1);
    expect(joseMocks.createRemoteJWKSet).toHaveBeenCalledWith(new URL(metadata.jwks_uri));
    expect(joseMocks.jwtVerify).toHaveBeenCalledTimes(2);
    expect(joseMocks.jwtVerify).toHaveBeenCalledWith("token-one", jwksFn, expect.objectContaining({
      issuer: metadata.issuer,
      audience: baseConfig.clientId
    }));
    expect(joseMocks.jwtVerify).toHaveBeenCalledWith("token-two", jwksFn, expect.any(Object));
  });
});
