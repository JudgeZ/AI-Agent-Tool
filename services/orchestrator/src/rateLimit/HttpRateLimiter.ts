import { RateLimitStore, createRateLimitStore, RateLimitDecision } from "./store.js";
import { appLogger } from "../observability/logger.js";

export type RateLimitResult = RateLimitDecision;

export class HttpRateLimiter {
    private store: RateLimitStore;

    constructor() {
        // Default to memory for now, or read config
        // In a real app, this should come from AppConfig
        this.store = createRateLimitStore({ provider: "memory" });
    }

    async allow(key: string, windowMs: number, maxRequests: number): Promise<RateLimitDecision> {
        return this.store.allow(key, windowMs, maxRequests);
    }

    async checkRateLimit(key: string, options: { limit: number; window: number }): Promise<RateLimitDecision> {
        return this.store.allow(key, options.window, options.limit);
    }
}
