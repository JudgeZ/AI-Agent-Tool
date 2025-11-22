import { buildRateLimitBuckets, type RequestIdentity } from "./requestIdentity.js";
import { recordRateLimitOutcome } from "../observability/metrics.js";
import type { RateLimitStore } from "../rateLimit/store.js";

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterMs?: number };

export async function enforceRateLimit(
  limiter: RateLimitStore,
  endpoint: string,
  identity: RequestIdentity,
  buckets: ReturnType<typeof buildRateLimitBuckets>,
): Promise<RateLimitResult> {
  for (const bucket of buckets) {
    const key = `${endpoint}:${bucket.identityType}:${
      bucket.identityType === "identity"
        ? (identity.subjectId ?? identity.agentName ?? identity.ip)
        : identity.ip
    }`;
    // RateLimitStore.allow returns Promise<RateLimitDecision>
    const result = await limiter.allow(key, bucket.windowMs, bucket.maxRequests);
    recordRateLimitOutcome(endpoint, bucket.identityType, result.allowed);
    if (!result.allowed) {
      return { allowed: false, retryAfterMs: result.retryAfterMs };
    }
  }
  return { allowed: true };
}

