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
  it("ignores forwarded headers from untrusted private origins", () => {
    const req = createIncomingMessage({
      remoteAddress: "10.0.0.5",
      forwardedFor: "203.0.113.10",
    });

    expect(resolveClientIp(req, [])).toBe("10.0.0.5");
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
