import type { Request } from "express";
import { describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "./config.js";
import {
  buildRateLimitBuckets,
  buildRateLimitKey,
  createRequestIdentity,
  extractAgent,
  normalizeRedirectIdentity,
} from "./http/requestIdentity.js";

type MockRequestOptions = {
  remoteAddress: string;
  forwardedFor?: string;
  agentName?: string;
};

function createMockRequest(options: MockRequestOptions): Request {
  const headers: Record<string, string> = {};
  if (options.forwardedFor) {
    headers["x-forwarded-for"] = options.forwardedFor;
  }
  if (options.agentName) {
    headers["x-agent"] = options.agentName;
  }
  const headerFn = (name: string) => {
    const key = name.toLowerCase();
    if (key === "x-forwarded-for") {
      return headers["x-forwarded-for"];
    }
    if (key === "x-agent") {
      return headers["x-agent"];
    }
    return undefined;
  };
  return {
    ip: options.remoteAddress,
    headers,
    socket: { remoteAddress: options.remoteAddress } as unknown as Request["socket"],
    header: headerFn as Request["header"],
  } as unknown as Request;
}

function withTrustedProxies(config: AppConfig, trustedProxyCidrs: string[]): AppConfig {
  return {
    ...config,
    server: {
      ...config.server,
      trustedProxyCidrs,
    },
  };
}

describe("createRequestIdentity", () => {
  it("binds rate limits to the remote address when no trusted proxy is configured", () => {
    const baseConfig = withTrustedProxies(loadConfig(), []);
    const req = createMockRequest({
      remoteAddress: "198.51.100.10",
      forwardedFor: "203.0.113.99",
    });

    const identity = createRequestIdentity(req, baseConfig);

    expect(identity.ip).toBe("198.51.100.10");
    expect(buildRateLimitKey(identity)).toBe("ip:198.51.100.10");
  });

  it("accepts forwarded addresses when the proxy subnet is trusted", () => {
    const base = loadConfig();
    const config = withTrustedProxies(base, ["198.51.100.0/24"]);
    const req = createMockRequest({
      remoteAddress: "198.51.100.10",
      forwardedFor: "203.0.113.99",
    });

    const identity = createRequestIdentity(req, config);

    expect(identity.ip).toBe("203.0.113.99");
    expect(buildRateLimitKey(identity)).toBe("ip:203.0.113.99");
  });
});

describe("buildRateLimitKey", () => {
  it("falls back to the client IP when unauthenticated requests spoof the agent header", () => {
    const config = withTrustedProxies(loadConfig(), []);
    const req = createMockRequest({
      remoteAddress: "198.51.100.11",
      agentName: "spoofed-agent",
    });

    const identity = createRequestIdentity(req, config);

    expect(identity.agentName).toBeUndefined();
    expect(buildRateLimitKey(identity)).toBe("ip:198.51.100.11");
  });

  it("keys authenticated requests by subject while preserving the agent tag", () => {
    const config = withTrustedProxies(loadConfig(), []);
    const req = createMockRequest({
      remoteAddress: "198.51.100.12",
      agentName: "code-writer",
    });
    const subject = {
      sessionId: "session-123",
      roles: [],
      scopes: [],
      user: { id: "user-123" },
    };

    const identity = createRequestIdentity(req, config, subject);

    expect(identity.subjectId).toBe("session-123");
    expect(identity.agentName).toBe("code-writer");
    expect(buildRateLimitKey(identity)).toBe("subject:session-123");
  });
});

describe("buildRateLimitBuckets", () => {
  it("returns only the IP bucket when identity limits are not configured", () => {
    const buckets = buildRateLimitBuckets("plan", {
      windowMs: 1000,
      maxRequests: 10,
    });

    expect(buckets).toEqual([
      {
        endpoint: "plan",
        identityType: "ip",
        windowMs: 1000,
        maxRequests: 10,
      },
    ]);
  });

  it("includes the identity bucket when identity limits are provided", () => {
    const buckets = buildRateLimitBuckets("plan", {
      windowMs: 1000,
      maxRequests: 10,
      identityWindowMs: 5000,
      identityMaxRequests: 3,
    });

    expect(buckets).toEqual([
      {
        endpoint: "plan",
        identityType: "ip",
        windowMs: 1000,
        maxRequests: 10,
      },
      {
        endpoint: "plan",
        identityType: "identity",
        windowMs: 5000,
        maxRequests: 3,
      },
    ]);
  });
});

describe("extractAgent", () => {
  it("returns the trimmed X-Agent header value when present", () => {
    const req = createMockRequest({
      remoteAddress: "198.51.100.30",
      agentName: "  test-agent  ",
    });

    expect(extractAgent(req)).toBe("test-agent");
  });

  it("falls back to the request body agent when the header is absent", () => {
    const req = {
      ...createMockRequest({ remoteAddress: "198.51.100.31" }),
      body: { agent: "body-agent" },
    } as Request;

    expect(extractAgent(req)).toBe("body-agent");
  });

  it("returns undefined when neither header nor body contain an agent", () => {
    const req = {
      ...createMockRequest({ remoteAddress: "198.51.100.32" }),
      body: { agent: "   " },
    } as Request;

    expect(extractAgent(req)).toBeUndefined();
  });
});

describe("normalizeRedirectIdentity", () => {
  it("returns undefined for empty or whitespace input", () => {
    expect(normalizeRedirectIdentity(undefined)).toBeUndefined();
    expect(normalizeRedirectIdentity("   ")).toBeUndefined();
  });

  it("normalizes URLs to hostname", () => {
    expect(normalizeRedirectIdentity("https://Example.COM/callback")).toBe("example.com");
  });

  it("normalizes URLs to hostname and port", () => {
    expect(normalizeRedirectIdentity("https://login.example.com:8443/auth"))
      .toBe("login.example.com:8443");
  });

  it("returns the trimmed value when parsing fails", () => {
    expect(normalizeRedirectIdentity("not a url"))
      .toBe("not a url");
  });
});

