import { ProviderError } from "./utils.js";
import type { RateLimitStore } from "../rateLimit/store.js";
import { createRateLimitStore } from "../rateLimit/store.js";

type StoredTask = {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

export type RateLimiterOptions = {
  windowMs: number;
  maxRequests: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

export class RateLimiter {
  private readonly queues = new Map<string, StoredTask[]>();
  private readonly processing = new Set<string>();
  private readonly options: RateLimiterOptions;
  private readonly store: RateLimitStore;

  constructor(options: RateLimiterOptions, store?: RateLimitStore, prefix = "orchestrator:provider-ratelimit") {
    if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
      throw new Error("RateLimiter windowMs must be a positive number");
    }
    if (!Number.isFinite(options.maxRequests) || options.maxRequests <= 0) {
      throw new Error("RateLimiter maxRequests must be a positive number");
    }
    this.options = options;
    this.store = store ?? createRateLimitStore({ provider: "memory" }, { prefix });
  }

  async schedule<T>(key: string, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: StoredTask = {
        fn: async () => task(),
        resolve: (value) => {
          resolve(value as T);
        },
        reject,
      };
      const queue = this.queues.get(key);
      if (queue) {
        queue.push(entry);
      } else {
        this.queues.set(key, [entry]);
      }
      void this.runQueue(key);
    });
  }

  reset(key?: string): void {
    if (typeof key === "string") {
      this.queues.delete(key);
      this.processing.delete(key);
      return;
    }
    this.queues.clear();
    this.processing.clear();
  }

  async shutdown(): Promise<void> {
    if (typeof this.store.disconnect === "function") {
      await this.store.disconnect();
    }
  }

  private async runQueue(key: string): Promise<void> {
    if (this.processing.has(key)) {
      return;
    }
    this.processing.add(key);

    try {
      while (true) {
        const queue = this.queues.get(key);
        if (!queue || queue.length === 0) {
          this.queues.delete(key);
          return;
        }

        const result = await this.store.allow(key, this.options.windowMs, this.options.maxRequests);
        if (!result.allowed) {
          const delay = Math.max(50, result.retryAfterMs || 0);
          await sleep(delay);
          continue;
        }

        const next = queue.shift()!;
        if (queue.length === 0) {
          this.queues.delete(key);
        }

        try {
          const res = await next.fn();
          next.resolve(res);
        } catch (error) {
          next.reject(error);
        }
      }
    } finally {
      this.processing.delete(key);
      if (this.queues.get(key)?.length) {
        void this.runQueue(key);
      }
    }
  }
}

type BreakerState = {
  state: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  openedAt?: number;
  lastError?: string;
};

export type CircuitBreakerOptions = {
  failureThreshold: number;
  resetTimeoutMs: number;
};

export class CircuitBreaker {
  private readonly states = new Map<string, BreakerState>();

  constructor(private readonly options: CircuitBreakerOptions) {}

  async execute<T>(key: string, action: () => Promise<T>): Promise<T> {
    const state = this.getState(key);
    const threshold = Math.max(1, this.options.failureThreshold);
    const now = Date.now();

    if (state.state === "open") {
      if (state.openedAt !== undefined && now - state.openedAt < this.options.resetTimeoutMs) {
        throw this.createOpenError(key, state);
      }
      state.state = "half_open";
    }

    try {
      const result = await action();
      state.consecutiveFailures = 0;
      state.openedAt = undefined;
      state.state = "closed";
      state.lastError = undefined;
      this.states.set(key, state);
      return result;
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);

      if (state.state === "half_open") {
        state.state = "open";
        state.openedAt = now;
        state.consecutiveFailures = threshold;
      } else {
        state.consecutiveFailures += 1;
        if (state.consecutiveFailures >= threshold) {
          state.state = "open";
          state.openedAt = now;
        }
      }

      this.states.set(key, state);
      throw error;
    }
  }

  reset(key?: string): void {
    if (typeof key === "string") {
      this.states.delete(key);
      return;
    }
    this.states.clear();
  }

  private getState(key: string): BreakerState {
    const existing = this.states.get(key);
    if (existing) {
      return existing;
    }
    const state: BreakerState = {
      state: "closed",
      consecutiveFailures: 0
    };
    this.states.set(key, state);
    return state;
  }

  private createOpenError(key: string, state: BreakerState): ProviderError {
    const reason = state.lastError ? ` last error: ${state.lastError}` : "";
    return new ProviderError(`Circuit breaker open for provider '${key}'.${reason}`, {
      status: 503,
      provider: key,
      retryable: true,
      code: "circuit_open"
    });
  }
}

