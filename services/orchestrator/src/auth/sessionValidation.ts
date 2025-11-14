import type { Request } from "express";

import { SessionIdSchema, formatValidationIssues } from "../http/validation.js";

export type SessionSource = "authorization" | "cookie";

export type SessionExtractionResult =
  | { status: "missing" }
  | { status: "valid"; sessionId: string; source: SessionSource }
  | {
      status: "invalid";
      source: SessionSource;
      issues: Array<{ path: string; message: string }>;
    };

export function validateSessionId(
  value: string,
  source: SessionSource,
): SessionExtractionResult {
  const result = SessionIdSchema.safeParse(value);
  if (!result.success) {
    return {
      status: "invalid",
      source,
      issues: formatValidationIssues(result.error.issues),
    };
  }
  return { status: "valid", sessionId: result.data, source };
}

export function extractSessionId(
  req: Request,
  cookieName: string,
): SessionExtractionResult {
  const authHeader = req.header("authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    return validateSessionId(token, "authorization");
  }
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) {
    return { status: "missing" };
  }
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rest] = part.split("=");
    if (!rawName) {
      continue;
    }
    const name = rawName.trim();
    if (name !== cookieName) {
      continue;
    }
    const rawValue = rest.join("=");
    const trimmedValue = rawValue.trim();
    let decoded = trimmedValue;
    try {
      decoded = decodeURIComponent(trimmedValue);
    } catch {
      // Preserve the raw value so validation can surface helpful errors.
    }
    return validateSessionId(decoded, "cookie");
  }
  return { status: "missing" };
}
