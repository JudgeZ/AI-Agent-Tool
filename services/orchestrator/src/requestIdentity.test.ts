import type { Request } from "express";
import { describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "./config.js";
import { buildRateLimitKey, createRequestIdentity } from "./index.js";

type MockRequestOptions = {
  remoteAddress: string;
  forwardedFor?: string;
};

function createMockRequest(options: MockRequestOptions): Request {
  const headers: Record<string, string> = {};
  if (options.forwardedFor) {
    headers["x-forwarded-for"] = options.forwardedFor;
  }
  const headerFn = (name: string) => {
    const key = name.toLowerCase();
    if (key === "x-forwarded-for") {
      return headers["x-forwarded-for"];
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

