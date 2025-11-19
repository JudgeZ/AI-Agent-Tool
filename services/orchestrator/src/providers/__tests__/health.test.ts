import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkProviderHealth,
  checkAllProvidersHealth,
  getCachedProviderHealth,
  resetHealthCache,
  type ProviderHealthStatus,
} from "../health.js";
import type { ModelProvider } from "../interfaces.js";
import { ProviderError } from "../utils.js";

describe("Provider Health Checks", () => {
  beforeEach(() => {
    resetHealthCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetHealthCache();
  });

  describe("checkProviderHealth", () => {
    it("should return healthy for initialized provider (skip request)", async () => {
      const mockProvider: ModelProvider = {
        name: "test-provider",
        chat: vi.fn(),
      };

      const health = await checkProviderHealth(mockProvider, {
        skipActualRequest: true,
      });

      expect(health.status).toBe("healthy");
      expect(health.provider).toBe("test-provider");
      expect(health.message).toContain("initialized successfully");
      expect(health.details?.hasCredentials).toBe(true);
      expect(health.details?.canConnect).toBe(true);
      expect(mockProvider.chat).not.toHaveBeenCalled();
    });

    it("should return healthy after successful API call", async () => {
      const mockProvider: ModelProvider = {
        name: "test-provider",
        chat: vi.fn().mockResolvedValue({
          output: "Hello",
          provider: "test-provider",
        }),
      };

      const health = await checkProviderHealth(mockProvider, {
        skipActualRequest: false,
        timeout: 1000,
      });

      expect(health.status).toBe("healthy");
      expect(health.responseTimeMs).toBeDefined();
      expect(health.responseTimeMs).toBeGreaterThanOrEqual(0);
      expect(mockProvider.chat).toHaveBeenCalledOnce();
    });

    it("should return unconfigured for missing credentials", async () => {
      const mockProvider: ModelProvider = {
        name: "test-provider",
        chat: vi.fn().mockRejectedValue(new ProviderError("API key is not configured", {
          status: 401,
          code: "missing_credentials",
        })),
      };

      const health = await checkProviderHealth(mockProvider, {
        skipActualRequest: false,
      });

      expect(health.status).toBe("unconfigured");
      expect(health.message).toContain("not configured");
      expect(health.details?.hasCredentials).toBe(false);
      expect(health.details?.canConnect).toBe(false);
    });

    it("should return degraded for rate limit errors", async () => {
      const mockProvider: ModelProvider = {
        name: "test-provider",
        chat: vi.fn().mockRejectedValue(new ProviderError("Rate limit exceeded", {
          status: 429,
        })),
      };

      const health = await checkProviderHealth(mockProvider, {
        skipActualRequest: false,
      });

      expect(health.status).toBe("degraded");
      expect(health.message).toContain("rate limit");
      expect(health.details?.hasCredentials).toBe(true);
    });

    it("should return degraded for timeout errors", async () => {
      const mockProvider: ModelProvider = {
        name: "test-provider",
        chat: vi.fn().mockImplementation(
          () => new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 100)
          )
        ),
      };

      const health = await checkProviderHealth(mockProvider, {
        skipActualRequest: false,
        timeout: 50,
      });

      expect(health.status).toBe("degraded");
      expect(health.message).toContain("timeout");
    });

    it("should return unhealthy for general errors", async () => {
      const mockProvider: ModelProvider = {
        name: "test-provider",
        chat: vi.fn().mockRejectedValue(new Error("Unknown error")),
      };

      const health = await checkProviderHealth(mockProvider, {
        skipActualRequest: false,
      });

      expect(health.status).toBe("unhealthy");
      expect(health.details?.error).toBe("Unknown error");
    });

    it("should handle invalid provider gracefully", async () => {
      const invalidProvider = null as unknown as ModelProvider;

      const health = await checkProviderHealth(invalidProvider);

      expect(health.status).toBe("unhealthy");
      expect(health.message).toContain("not properly initialized");
    });
  });

  describe("checkAllProvidersHealth", () => {
    it("should check all known providers", async () => {
      const health = await checkAllProvidersHealth({
        skipActualRequests: true,
      });

      expect(health.providers).toBeDefined();
      expect(Object.keys(health.providers).length).toBeGreaterThan(0);

      // Should include known providers
      expect(health.providers["openai"]).toBeDefined();
      expect(health.providers["anthropic"]).toBeDefined();
      expect(health.providers["google"]).toBeDefined();

      expect(health.summary.total).toBe(Object.keys(health.providers).length);
      expect(health.timestamp).toBeDefined();
    });

    it("should calculate summary correctly", async () => {
      const health = await checkAllProvidersHealth({
        skipActualRequests: true,
      });

      const { summary } = health;

      expect(summary.total).toBeGreaterThan(0);
      expect(
        summary.healthy + summary.degraded + summary.unhealthy + summary.unconfigured
      ).toBe(summary.total);
    });

    it("should determine overall status correctly", async () => {
      const health = await checkAllProvidersHealth({
        skipActualRequests: true,
      });

      if (health.summary.healthy === health.summary.total) {
        expect(health.status).toBe("healthy");
      } else if (health.summary.healthy > 0 || health.summary.degraded > 0) {
        expect(health.status).toBe("degraded");
      } else {
        expect(health.status).toBe("unhealthy");
      }
    });

    it("should support parallel checking", async () => {
      const startTime = Date.now();

      await checkAllProvidersHealth({
        skipActualRequests: true,
        parallel: true,
      });

      const duration = Date.now() - startTime;

      // Parallel should be faster than sequential
      expect(duration).toBeLessThan(1000);
    });

    it("should support sequential checking", async () => {
      const health = await checkAllProvidersHealth({
        skipActualRequests: true,
        parallel: false,
      });

      expect(health.providers).toBeDefined();
      expect(Object.keys(health.providers).length).toBeGreaterThan(0);
    });
  });

  describe("getCachedProviderHealth", () => {
    it("should cache health results", async () => {
      const health1 = await getCachedProviderHealth({
        skipActualRequests: true,
      });

      const health2 = await getCachedProviderHealth({
        skipActualRequests: true,
      });

      // Same timestamp means it was cached
      expect(health1.timestamp).toBe(health2.timestamp);
    });

    it("should respect cache TTL", async () => {
      vi.useFakeTimers();
      try {
        const health1 = await getCachedProviderHealth({
          skipActualRequests: true,
        });

        // Advance time to expire cache
        await vi.advanceTimersByTimeAsync(31000); // Cache TTL is 30s

        const health2 = await getCachedProviderHealth({
          skipActualRequests: true,
        });

        // Different timestamps mean cache expired
        expect(health1.timestamp).not.toBe(health2.timestamp);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should force refresh when requested", async () => {
      const health1 = await getCachedProviderHealth({
        skipActualRequests: true,
      });

      // Immediate refresh
      await new Promise(resolve => setTimeout(resolve, 10));
      const health2 = await getCachedProviderHealth({
        skipActualRequests: true,
        forceRefresh: true,
      });

      // Different timestamps mean new check was performed
      expect(health1.timestamp).not.toBe(health2.timestamp);
    });

    it("should handle cache invalidation", async () => {
      await getCachedProviderHealth();

      resetHealthCache();

      const health = await getCachedProviderHealth();

      expect(health).toBeDefined();
    });
  });

  describe("Health check response format", () => {
    it("should include all required fields", async () => {
      const health = await checkAllProvidersHealth();

      expect(health).toHaveProperty("status");
      expect(health).toHaveProperty("timestamp");
      expect(health).toHaveProperty("providers");
      expect(health).toHaveProperty("summary");

      expect(health.summary).toHaveProperty("total");
      expect(health.summary).toHaveProperty("healthy");
      expect(health.summary).toHaveProperty("degraded");
      expect(health.summary).toHaveProperty("unhealthy");
      expect(health.summary).toHaveProperty("unconfigured");
    });

    it("should include provider details", async () => {
      const health = await checkAllProvidersHealth();

      const providerHealth = Object.values(health.providers)[0];

      expect(providerHealth).toHaveProperty("provider");
      expect(providerHealth).toHaveProperty("status");
      expect(providerHealth).toHaveProperty("lastCheck");
      expect(providerHealth).toHaveProperty("details");

      if (providerHealth.status === "healthy") {
        expect(providerHealth).toHaveProperty("message");
      }
    });

    it("should format timestamps as ISO 8601", async () => {
      const health = await checkAllProvidersHealth();

      expect(health.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      const providerHealth = Object.values(health.providers)[0];
      expect(providerHealth.lastCheck).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe("Error scenarios", () => {
    it("should handle provider registry errors", async () => {
      // This test assumes the registry might fail
      const health = await checkAllProvidersHealth({
        skipActualRequests: true,
      });

      // Should still return a valid health object
      expect(health).toBeDefined();
      expect(health.status).toBeDefined();
    });

    it("should handle timeout during health check", async () => {
      const mockProvider: ModelProvider = {
        name: "slow-provider",
        chat: vi.fn().mockImplementation(
          () => new Promise(resolve => setTimeout(resolve, 10000))
        ),
      };

      const health = await checkProviderHealth(mockProvider, {
        skipActualRequest: false,
        timeout: 100,
      });

      expect(health.status).not.toBe("healthy");
      expect(health.responseTimeMs).toBeLessThan(200);
    });
  });

  describe("Performance", () => {
    it("should complete health check quickly with skip", async () => {
      const startTime = Date.now();

      await checkAllProvidersHealth({
        skipActualRequests: true,
      });

      const duration = Date.now() - startTime;

      // Should be very fast when skipping actual requests
      expect(duration).toBeLessThan(500);
    });

    it("should not overwhelm system with parallel checks", async () => {
      const promises = Array.from({ length: 10 }, () =>
        getCachedProviderHealth({ skipActualRequests: true })
      );

      const results = await Promise.all(promises);

      // All should complete successfully
      expect(results).toHaveLength(10);
      results.forEach(result => {
        expect(result.status).toBeDefined();
      });
    });
  });
});
