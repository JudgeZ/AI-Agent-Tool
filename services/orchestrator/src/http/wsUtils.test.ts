import type { IncomingMessage } from "node:http";
import ipaddr from "ipaddr.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { appLogger } from "../observability/logger.js";
import { isTrustedProxyIp, resolveClientIp } from "./wsUtils.js";

type MockRequestOptions = {
  remoteAddress?: string | null;
  forwardedFor?: string;
};

function createIncomingMessage(options: MockRequestOptions): IncomingMessage {
  const headers: Record<string, string> = {};
  if (options.forwardedFor) {
    headers["x-forwarded-for"] = options.forwardedFor;
  }
  return {
    headers,
    socket: { remoteAddress: options.remoteAddress } as IncomingMessage["socket"],
  } as IncomingMessage;
}

describe("resolveClientIp", () => {
  it("honors forwarded headers from private origins when no trusted proxies are configured", () => {
    const req = createIncomingMessage({
      remoteAddress: "10.0.0.5",
      forwardedFor: "203.0.113.10",
    });

    expect(resolveClientIp(req, [])).toBe("203.0.113.10");
  });

  it("ignores forwarded headers from private origins when trusted proxies are configured", () => {
    const req = createIncomingMessage({
      remoteAddress: "10.0.0.5",
      forwardedFor: "203.0.113.10",
    });

    expect(resolveClientIp(req, ["192.168.0.0/16"])).toBe("10.0.0.5");
  });

  it("uses private forwarded entries when private forwarding is allowed", () => {
    const req = createIncomingMessage({
      remoteAddress: "10.0.0.5",
      forwardedFor: "10.0.0.6",
    });

    expect(resolveClientIp(req, [])).toBe("10.0.0.6");
  });
});

describe("isTrustedProxyIp", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("logs malformed CIDR entries and continues", () => {
    const warnSpy = vi.spyOn(appLogger, "warn");

    const result = isTrustedProxyIp(ipaddr.parse("10.0.0.1"), ["not-a-cidr"]);

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cidr: "not-a-cidr" }),
      "invalid trusted proxy CIDR entry",
    );
  });
});
