import type { IDedupeService } from "./IDedupeService.js";

type ClaimEntry = {
  expiresAt: number;
};

/**
 * In-memory deduplication service implementation.
 *
 * Suitable for development and single-instance deployments.
 * For horizontal scaling, use RedisDedupeService instead.
 *
 * LIMITATIONS:
 * - Claims are lost on process restart
 * - Not shared across multiple instances
 * - Memory usage grows with active claims
 */
export class MemoryDedupeService implements IDedupeService {
  private readonly claims = new Map<string, ClaimEntry>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly cleanupIntervalMs: number;

  constructor(cleanupIntervalMs = 60000) {
    this.cleanupIntervalMs = cleanupIntervalMs;
    this.startCleanup();
  }

  private startCleanup(): void {
    if (this.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.cleanupExpired();
      }, this.cleanupIntervalMs);
      this.cleanupTimer.unref();
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.claims.entries()) {
      if (entry.expiresAt <= now) {
        this.claims.delete(key);
      }
    }
  }

  async claim(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();

    // Check if already claimed and not expired
    const existing = this.claims.get(key);
    if (existing && existing.expiresAt > now) {
      return false;
    }

    // Claim the key
    const safeTtlMs = Math.max(1, Math.floor(ttlMs));
    this.claims.set(key, { expiresAt: now + safeTtlMs });
    return true;
  }

  async release(key: string): Promise<void> {
    this.claims.delete(key);
  }

  async isClaimed(key: string): Promise<boolean> {
    const entry = this.claims.get(key);
    if (!entry) {
      return false;
    }
    if (entry.expiresAt <= Date.now()) {
      this.claims.delete(key);
      return false;
    }
    return true;
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.claims.clear();
  }
}
