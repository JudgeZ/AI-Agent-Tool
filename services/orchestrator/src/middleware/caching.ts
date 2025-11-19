/**
 * Caching middleware for Express routes
 *
 * Provides automatic caching for expensive operations
 */

import type { Request, Response, NextFunction } from "express";
import {
  getPromptCache,
  getEmbeddingCache,
  getCompletionCache,
} from "../cache/index.js";
import { appLogger } from "../observability/logger.js";
import crypto from "crypto";

/**
 * Cache middleware options
 */
export interface CacheMiddlewareOptions {
  /** Cache type to use */
  cacheType: "prompt" | "embedding" | "completion";

  /** TTL in seconds (optional, uses cache defaults) */
  ttl?: number;

  /** Enable semantic matching for prompts */
  semanticMatch?: boolean;

  /** Similarity threshold for semantic matching (0-1) */
  threshold?: number;

  /** Function to generate cache key from request */
  keyGenerator?: (req: Request) => string;

  /** Function to check if response should be cached */
  shouldCache?: (req: Request, res: Response) => boolean;
}

/**
 * Default cache key generator
 */
function defaultKeyGenerator(req: Request): string {
  const parts = [
    req.method,
    req.path,
    JSON.stringify(req.query),
    JSON.stringify(req.body),
  ];

  return crypto.createHash("sha256").update(parts.join(":")).digest("hex");
}

/**
 * Cache middleware for responses
 */
export function cacheMiddleware(options: CacheMiddlewareOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const keyGenerator = options.keyGenerator || defaultKeyGenerator;
    const cacheKey = keyGenerator(req);

    // Get appropriate cache
    let cache;
    switch (options.cacheType) {
      case "prompt":
        cache = getPromptCache();
        break;
      case "embedding":
        cache = getEmbeddingCache();
        break;
      case "completion":
        cache = getCompletionCache();
        break;
      default:
        return next();
    }

    try {
      // Try cache hit
      let cachedValue = null;

      if (options.semanticMatch && options.cacheType === "prompt") {
        // Semantic matching for prompts
        const query =
          req.body?.prompt || req.body?.messages?.[0]?.content || "";
        if (query && "getBySemanticSimilarity" in cache) {
          const match = await (cache as any).getBySemanticSimilarity(query, {
            threshold: options.threshold || 0.95,
          });

          if (match) {
            cachedValue = match.value;
            appLogger.debug(
              { cacheKey, similarity: match.similarity },
              "cache hit (semantic)",
            );
          }
        }
      } else {
        // Exact key matching
        cachedValue = await cache.get(cacheKey);

        if (cachedValue) {
          appLogger.debug({ cacheKey }, "cache hit (exact)");
        }
      }

      // Return cached response
      if (cachedValue) {
        res.setHeader("X-Cache", "HIT");
        res.setHeader("X-Cache-Key", cacheKey);
        return res.json(cachedValue);
      }

      // Cache miss - intercept response to cache it
      res.setHeader("X-Cache", "MISS");
      res.setHeader("X-Cache-Key", cacheKey);

      const originalJson = res.json.bind(res);
      res.json = function (body: any) {
        // Check if we should cache this response
        const shouldCache = options.shouldCache?.(req, res) ?? true;

        if (shouldCache && res.statusCode >= 200 && res.statusCode < 300) {
          // Cache response asynchronously
          setImmediate(async () => {
            try {
              await cache.set(cacheKey, body, {
                ttl: options.ttl,
              });

              appLogger.debug({ cacheKey }, "response cached");
            } catch (error) {
              appLogger.error(
                { err: error, cacheKey },
                "failed to cache response",
              );
            }
          });
        }

        return originalJson(body);
      };

      next();
    } catch (error) {
      appLogger.error({ err: error, cacheKey }, "cache middleware error");
      next(); // Continue without caching on error
    }
  };
}

/**
 * Middleware to cache prompt responses
 */
export function promptCacheMiddleware(
  options?: Partial<CacheMiddlewareOptions>,
) {
  return cacheMiddleware({
    cacheType: "prompt",
    semanticMatch: true,
    threshold: 0.95,
    ...options,
  });
}

/**
 * Middleware to cache embedding responses
 */
export function embeddingCacheMiddleware(
  options?: Partial<CacheMiddlewareOptions>,
) {
  return cacheMiddleware({
    cacheType: "embedding",
    ...options,
  });
}

/**
 * Middleware to cache completion responses
 */
export function completionCacheMiddleware(
  options?: Partial<CacheMiddlewareOptions>,
) {
  return cacheMiddleware({
    cacheType: "completion",
    threshold: 0.98, // Higher threshold for completions
    ...options,
  });
}

/**
 * Cache invalidation middleware
 * Add to routes that modify data
 */
export function cacheInvalidationMiddleware(patterns: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Continue with request
    const originalJson = res.json.bind(res);

    res.json = function (body: any) {
      // Invalidate cache patterns on successful response
      if (res.statusCode >= 200 && res.statusCode < 300) {
        setImmediate(async () => {
          try {
            const caches = [
              getPromptCache(),
              getEmbeddingCache(),
              getCompletionCache(),
            ];

            for (const cache of caches) {
              for (const pattern of patterns) {
                if ("invalidatePattern" in cache) {
                  await (cache as any).invalidatePattern(pattern);
                }
              }
            }

            appLogger.debug({ patterns }, "cache invalidated");
          } catch (error) {
            appLogger.error(
              { err: error, patterns },
              "failed to invalidate cache",
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
 * Manual cache operations helper
 */
export const CacheHelper = {
  /**
   * Get cached value
   */
  async get(cacheType: "prompt" | "embedding" | "completion", key: string) {
    switch (cacheType) {
      case "prompt":
        return getPromptCache().get(key);
      case "embedding":
        return getEmbeddingCache().get(key);
      case "completion":
        return getCompletionCache().get(key);
    }
  },

  /**
   * Set cached value
   */
  async set(
    cacheType: "prompt" | "embedding" | "completion",
    key: string,
    value: any,
    options?: { ttl?: number },
  ) {
    switch (cacheType) {
      case "prompt":
        return getPromptCache().set(key, value, options);
      case "embedding":
        return getEmbeddingCache().set(key, value, options);
      case "completion":
        return getCompletionCache().set(key, value, options);
    }
  },

  /**
   * Invalidate cache pattern
   */
  async invalidate(pattern: string) {
    const caches = [
      getPromptCache(),
      getEmbeddingCache(),
      getCompletionCache(),
    ];

    for (const cache of caches) {
      if ("invalidatePattern" in cache) {
        await (cache as any).invalidatePattern(pattern);
      }
    }
  },

  /**
   * Clear all caches
   */
  async clearAll() {
    const caches = [
      getPromptCache(),
      getEmbeddingCache(),
      getCompletionCache(),
    ];

    for (const cache of caches) {
      await cache.clear();
    }
  },
};
