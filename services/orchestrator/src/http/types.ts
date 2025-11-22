import type { Request } from "express";
import type { SessionRecord } from "../auth/SessionStore.js";

export type AuthError = {
  code: "invalid_session";
  source: "authorization" | "cookie";
  issues: Array<{ path: string; message: string }>;
};

export type ExtendedRequest = Request & {
  auth?: {
    session?: SessionRecord;
    error?: AuthError;
  };
};

