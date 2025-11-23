import { appLogger } from "../observability/logger.js";
import {
  createRateLimitStore,
  type LoggerLike,
  type RateLimitBackendConfig,
  type RateLimitStore,
  type RateLimitDecision,
} from "../rateLimit/store.js";

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  limit: number;
  windowMs: number;
  retryAfterMs?: number;
};

export type SessionRateLimiterOptions = {
  prefix?: string;
  backend?: RateLimitBackendConfig;
  store?: RateLimitStore;
  logger?: LoggerLike;
};

const DEFAULT_PREFIX = "orchestrator:session-rate-limit";

/**
 * Resolves the backing store for rate limiting. Multi-instance deployments
 * should supply a Redis backend (via ORCHESTRATOR_RATE_LIMIT_BACKEND=redis and
 * ORCHESTRATOR_RATE_LIMIT_REDIS_URL or RATE_LIMIT_REDIS_URL) to ensure limits
 * are enforced across processes; otherwise the in-memory backend scopes limits
 * to a single orchestrator instance.
 */
export function resolveBackendFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitBackendConfig {
  const providerEnv = env.ORCHESTRATOR_RATE_LIMIT_BACKEND?.toLowerCase();
  const redisUrl = env.ORCHESTRATOR_RATE_LIMIT_REDIS_URL ?? env.RATE_LIMIT_REDIS_URL;
  const wantsRedis = providerEnv === "redis" || (!!redisUrl && providerEnv !== "memory");
  if (wantsRedis && !redisUrl) {
    appLogger.warn({ providerEnv }, "redis rate limit backend requested without redis url; falling back to memory");
    return { provider: "memory" };
  }
  return wantsRedis && redisUrl ? { provider: "redis", redisUrl } : { provider: "memory" };
}

export class PerSessionRateLimiter {
  private readonly store: RateLimitStore;
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number, options: SessionRateLimiterOptions = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    const backend = options.backend ?? resolveBackendFromEnv();
    const logger = options.logger ??
      (typeof appLogger.child === "function"
        ? appLogger.child({ component: "session-rate-limit" })
        : appLogger);
    this.store = options.store ??
      createRateLimitStore(backend, {
        prefix: options.prefix ?? DEFAULT_PREFIX,
        logger,
      });
  }

  async check(sessionId: string): Promise<RateLimitResult> {
    const decision = await this.store.allow(sessionId, this.windowMs, this.limit);
    return this.toResult(decision);
  }

  async reset(sessionId?: string): Promise<void> {
    if (typeof this.store.reset === "function") {
      await this.store.reset(sessionId);
    }
  }

  private toResult(decision: RateLimitDecision): RateLimitResult {
    const remaining = Math.max(0, decision.remaining ?? (decision.allowed ? this.limit - 1 : 0));
    return {
      allowed: decision.allowed,
      remaining,
      limit: decision.limit ?? this.limit,
      windowMs: decision.windowMs ?? this.windowMs,
      retryAfterMs: decision.retryAfterMs,
    };
  }
}
