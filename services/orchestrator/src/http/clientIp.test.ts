import type { Request } from "express";
import { describe, expect, it } from "vitest";

import { resolveClientIp } from "./clientIp.js";

type MockRequestOptions = {
  remoteAddress?: string;
  ip?: string;
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
    ip: options.ip ?? options.remoteAddress ?? "",
    headers,
    socket: { remoteAddress: options.remoteAddress } as unknown as Request["socket"],
    header: headerFn as Request["header"],
  } as unknown as Request;
}

describe("resolveClientIp", () => {
  it("prefers the direct remote address when no trusted proxy is configured", () => {
    const req = createMockRequest({
      remoteAddress: "192.0.2.10",
      forwardedFor: "203.0.113.1",
    });

    expect(resolveClientIp(req, [])).toBe("192.0.2.10");
  });

  it("extracts the original client IP when the remote address matches a trusted proxy", () => {
    const req = createMockRequest({
      remoteAddress: "10.0.0.5",
      forwardedFor: "203.0.113.44",
    });

    expect(resolveClientIp(req, ["10.0.0.0/8"])).toBe("203.0.113.44");
  });

  it("ignores forged headers that are not valid IP addresses", () => {
    const req = createMockRequest({
      remoteAddress: "::ffff:192.0.2.33",
      forwardedFor: "malicious-value",
    });

    expect(resolveClientIp(req, ["::ffff:192.0.2.0/112"]))
      .toBe("192.0.2.33");
  });

  it("uses the closest untrusted hop in a forwarded-for chain", () => {
    const req = createMockRequest({
      remoteAddress: "10.0.0.9",
      forwardedFor: "203.0.113.44, 198.51.100.2",
    });

    expect(resolveClientIp(req, ["10.0.0.0/8"])).toBe("198.51.100.2");
  });

  it("supports IPv6 trusted proxies", () => {
    const req = createMockRequest({
      remoteAddress: "2001:db8::1",
      forwardedFor: "2001:db8::abcd",
    });

    expect(resolveClientIp(req, ["2001:db8::1"]))
      .toBe("2001:db8::abcd");
  });

  it("ignores spoofed values that precede the trusted proxy hops", () => {
    const req = createMockRequest({
      remoteAddress: "10.0.0.10",
      forwardedFor: "1.2.3.4, 203.0.113.9",
    });

    expect(resolveClientIp(req, ["10.0.0.0/8"])).toBe("203.0.113.9");
  });
});

