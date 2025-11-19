/**
 * Cost tracking middleware for Express routes
 *
 * Automatically tracks token usage and costs for LLM operations
 */

import type { Request, Response, NextFunction } from "express";
import { getCostTracker, getTokenCounter } from "../cost/index.js";
import { appLogger } from "../observability/logger.js";
import type { TokenUsage } from "../cost/types.js";

/**
 * LLM response body structure
 * Represents different response formats from various LLM providers
 */
interface LLMResponseBody {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  response?: {
    usage?: unknown;
  };
  tokenUsage?: TokenUsage;
  [key: string]: unknown; // Allow additional properties
}

/**
 * Extract operation metadata from request
 */
function extractOperationMetadata(req: Request): {
  operation: string;
  tenant?: string;
  provider?: string;
  model?: string;
} {
  // Determine operation from route
  let operation = "unknown";
  if (req.path.includes("/chat")) {
    operation = "chat";
  } else if (req.path.includes("/plan")) {
    operation = "plan";
  } else if (req.path.includes("/embedding")) {
    operation = "embedding";
  } else if (req.path.includes("/completion")) {
    operation = "completion";
  }

  // Extract tenant from session or request
  const tenant = req.auth?.session?.tenantId;

  // Extract provider and model from request body or query
  const provider = req.body?.provider || (req.query?.provider as string);
  const model = req.body?.model || (req.query?.model as string);

  return { operation, tenant, provider, model };
}

/**
 * Middleware to track costs for LLM operations
 */
export function costTrackingMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Skip if not an LLM operation
    if (!shouldTrackCost(req)) {
      return next();
    }

    const costTracker = getCostTracker();
    const metadata = extractOperationMetadata(req);

    // Store start time
    const startTime = Date.now();

    // Intercept response to capture usage
    const originalJson = res.json.bind(res);
    res.json = function (body: LLMResponseBody) {
      // Extract token usage from response
      const usage = extractTokenUsage(body);

      if (usage) {
        // Track the operation asynchronously (don't block response)
        setImmediate(async () => {
          try {
            const duration = Date.now() - startTime;

            await costTracker.trackOperation(
              {
                operation: metadata.operation,
                tenant: metadata.tenant,
                provider: metadata.provider || "unknown",
                model: metadata.model || "unknown",
              },
              async () => ({
                result: body,
                usage,
                duration,
              }),
            );
          } catch (error) {
            appLogger.error(
              { err: error, operation: metadata.operation },
              "failed to track operation cost",
            );
          }
        });
      }

      return originalJson(body);
    };

    next();
  };
}

/**
 * Check if request should have cost tracking
 */
function shouldTrackCost(req: Request): boolean {
  const path = req.path.toLowerCase();

  return (
    path.includes("/chat") ||
    path.includes("/completion") ||
    path.includes("/embedding") ||
    (path.includes("/plan") && req.method === "POST")
  );
}

/**
 * Extract token usage from response body
 */
function extractTokenUsage(body: LLMResponseBody): TokenUsage | null {
  // Standard OpenAI format
  if (body?.usage) {
    return {
      promptTokens: body.usage.prompt_tokens || 0,
      completionTokens: body.usage.completion_tokens || 0,
      totalTokens: body.usage.total_tokens || 0,
    };
  }

  // Anthropic format
  if (body?.usage?.input_tokens) {
    return {
      promptTokens: body.usage.input_tokens,
      completionTokens: body.usage.output_tokens || 0,
      totalTokens:
        (body.usage.input_tokens || 0) + (body.usage.output_tokens || 0),
    };
  }

  // Custom format in response
  if (body?.response && typeof body.response === "object") {
    return extractTokenUsage(body.response as LLMResponseBody);
  }

  // Token usage explicitly set
  if (body?.tokenUsage) {
    return body.tokenUsage;
  }

  return null;
}

/**
 * Middleware to add token counter to request context
 */
export function tokenCounterMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    // Attach token counter to request for easy access
    req.tokenCounter = getTokenCounter();
    next();
  };
}

/**
 * Helper to manually track an operation with cost
 */
export async function trackOperationCost<T>(
  operation: string,
  provider: string,
  model: string,
  fn: () => Promise<{ result: T; usage?: TokenUsage }>,
  options?: { tenant?: string },
): Promise<{ result: T; metrics: import("../cost/types.js").CostMetrics }> {
  const costTracker = getCostTracker();

  const tracked = await costTracker.trackOperation(
    {
      operation,
      provider,
      model,
      tenant: options?.tenant,
    },
    fn,
  );

  return {
    result: (tracked.result as { result: T }).result,
    metrics: tracked.metrics,
  };
}
