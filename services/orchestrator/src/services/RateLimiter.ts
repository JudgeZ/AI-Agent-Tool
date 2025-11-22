export type RateLimitResult =
  | { allowed: true; remaining: number; limit: number; windowMs: number }
  | { allowed: false; remaining: number; limit: number; windowMs: number };

export class PerSessionRateLimiter {
  private readonly limits = new Map<string, { windowStart: number; count: number }>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  check(sessionId: string): RateLimitResult {
    const now = Date.now();
    const current = this.limits.get(sessionId);
    if (!current || now - current.windowStart >= this.windowMs) {
      this.limits.set(sessionId, { windowStart: now, count: 1 });
      return { allowed: true, remaining: Math.max(0, this.limit - 1), limit: this.limit, windowMs: this.windowMs };
    }

    const nextCount = current.count + 1;
    if (nextCount > this.limit) {
      this.limits.set(sessionId, { windowStart: current.windowStart, count: nextCount });
      return { allowed: false, remaining: 0, limit: this.limit, windowMs: this.windowMs };
    }

    this.limits.set(sessionId, { windowStart: current.windowStart, count: nextCount });
    return { allowed: true, remaining: Math.max(0, this.limit - nextCount), limit: this.limit, windowMs: this.windowMs };
  }

  reset(sessionId?: string): void {
    if (sessionId) {
      this.limits.delete(sessionId);
      return;
    }
    this.limits.clear();
  }
}
