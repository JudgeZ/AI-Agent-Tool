import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import type { Request } from "express";

import { extractSessionId, validateSessionId } from "./sessionValidation.js";

function buildRequest({
  authorization,
  cookie,
}: {
  authorization?: string;
  cookie?: string;
}): Request {
  return {
    header(name: string) {
      if (name.toLowerCase() === "authorization") {
        return authorization ?? undefined;
      }
      return undefined;
    },
    headers: cookie ? { cookie } : {},
  } as unknown as Request;
}

describe("sessionValidation", () => {
  it("validates bearer tokens from the authorization header", () => {
    const sessionId = randomUUID();
    const result = extractSessionId(
      buildRequest({ authorization: `Bearer ${sessionId}` }),
      "oss_session",
    );
    expect(result).toEqual({
      status: "valid",
      sessionId,
      source: "authorization",
    });
  });

  it("returns missing when the session cookie value is empty", () => {
    const result = extractSessionId(
      buildRequest({ cookie: "oss_session=; other=value" }),
      "oss_session",
    );
    expect(result).toEqual({ status: "missing" });
  });

  it("returns validation issues for malformed cookie session ids", () => {
    const result = extractSessionId(
      buildRequest({ cookie: "oss_session=not-a-uuid" }),
      "oss_session",
    );
    expect(result.status).toBe("invalid");
    expect(result.source).toBe("cookie");
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("reuses validation logic across helpers", () => {
    const result = validateSessionId("invalid", "authorization");
    expect(result.status).toBe("invalid");
    expect(result.source).toBe("authorization");
    expect(result.issues.length).toBeGreaterThan(0);
  });
});
