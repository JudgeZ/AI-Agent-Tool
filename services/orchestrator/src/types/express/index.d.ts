import type { SessionRecord } from "../../auth/SessionStore.js";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        session?: SessionRecord;
      };
    }
  }
}

export {};
