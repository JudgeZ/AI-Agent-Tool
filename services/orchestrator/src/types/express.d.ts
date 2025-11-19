/**
 * Express Request type extensions
 *
 * Augments Express.Request with custom properties used throughout the orchestrator.
 * This eliminates the need for `any` type assertions when accessing custom properties.
 */

import type { TokenCounter } from "../cost/TokenCounter.js";
import type { SessionRecord } from "../auth/SessionStore.js";

declare global {
  namespace Express {
    interface Request {
      /**
       * Authentication and session information
       * Set by authentication middleware
       */
      auth?: {
        session?: SessionRecord;
        error?: {
          code: string;
          source: string;
          issues: Array<{ path: string; message: string }>;
        };
      };

      /**
       * Token counter for tracking LLM token usage
       * Set by tokenCounterMiddleware
       */
      tokenCounter?: TokenCounter;

      /**
       * Request-scoped trace ID for distributed tracing
       * Set by tracing middleware
       */
      traceId?: string;

      /**
       * Request-scoped logger with context
       * Set by logging middleware
       */
      scopedLogger?: import("pino").Logger;
    }
  }
}

// Required for TypeScript module augmentation
export {};
