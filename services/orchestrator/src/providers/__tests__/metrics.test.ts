import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { register } from "prom-client";
import {
  ProviderRequestTimer,
  recordClientRotation,
  recordProviderError,
  recordTokenUsage,
  recordCacheHit,
  recordCacheMiss,
  recordRateLimit,
  updateCircuitBreakerState,
  resetProviderMetrics,
  startProviderRequest,
} from "../metrics.js";

describe("Provider Metrics", () => {
  beforeEach(() => {
    resetProviderMetrics();
  });

  afterEach(() => {
    resetProviderMetrics();
  });

  describe("ProviderRequestTimer", () => {
    it("should record successful request duration and token usage", async () => {
      const timer = new ProviderRequestTimer({
        provider: "test-provider",
        model: "test-model",
        operation: "chat",
      });

      // Simulate some work
      await new Promise((resolve) => setTimeout(resolve, 10));

      timer.success({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      });

      // Verify metrics were recorded
      const metrics = await register.metrics();
      expect(metrics).toContain("provider_request_duration_seconds");
      expect(metrics).toContain("provider_requests_total");
      expect(metrics).toContain("provider_token_usage_total");
      expect(metrics).toContain('provider="test-provider"');
      expect(metrics).toContain('model="test-model"');
    });

    it("should record error metrics correctly", async () => {
      const timer = new ProviderRequestTimer({
        provider: "test-provider",
        model: "test-model",
        operation: "chat",
      });

      timer.error({
        status: 500,
        code: "internal_error",
        retryable: true,
      });

      const metrics = await register.metrics();
      expect(metrics).toContain("provider_errors_total");
      expect(metrics).toContain('error_type="internal_error"');
      expect(metrics).toContain('status_code="500"');
    });

    it("should record cache hit", () => {
      const timer = new ProviderRequestTimer({
        provider: "test-provider",
        model: "test-model",
        operation: "chat",
      });

      timer.cacheHit();

      register.metrics().then((metrics) => {
        expect(metrics).toContain("provider_cache_hits_total");
      });
    });

    it("should only allow one completion per timer", () => {
      const timer = new ProviderRequestTimer({
        provider: "test-provider",
        model: "test-model",
        operation: "chat",
      });

      timer.success({});
      timer.success({}); // Should be ignored

      // Timer should be marked as ended
      expect(() => timer.error({ status: 500 })).not.toThrow();
    });
  });

  describe("recordClientRotation", () => {
    it("should increment rotation counter", async () => {
      recordClientRotation("test-provider", "credential_change");
      recordClientRotation("test-provider", "credential_change");

      const metrics = await register.metrics();
      expect(metrics).toContain("provider_client_rotations_total");
      expect(metrics).toContain('provider="test-provider"');
      expect(metrics).toContain('reason="credential_change"');
    });

    it("should support different rotation reasons", async () => {
      recordClientRotation("test-provider", "credential_change");
      recordClientRotation("test-provider", "error");
      recordClientRotation("test-provider", "manual");

      const metrics = await register.metrics();
      expect(metrics).toContain('reason="credential_change"');
      expect(metrics).toContain('reason="error"');
      expect(metrics).toContain('reason="manual"');
    });
  });

  describe("recordProviderError", () => {
    it("should record error with all details", async () => {
      recordProviderError(
        {
          provider: "test-provider",
          model: "test-model",
          operation: "chat",
        },
        {
          status: 429,
          code: "rate_limit",
          retryable: true,
        }
      );

      const metrics = await register.metrics();
      expect(metrics).toContain("provider_errors_total");
      expect(metrics).toContain('error_type="rate_limit"');
      expect(metrics).toContain('status_code="429"');
    });

    it("should handle errors without codes", async () => {
      recordProviderError(
        {
          provider: "test-provider",
          model: "test-model",
          operation: "chat",
        },
        {
          status: 500,
          retryable: false,
        }
      );

      const metrics = await register.metrics();
      expect(metrics).toContain('error_type="non_retryable"');
    });
  });

  describe("recordTokenUsage", () => {
    it("should record all token types", async () => {
      recordTokenUsage(
        {
          provider: "test-provider",
          model: "test-model",
        },
        {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        }
      );

      const metrics = await register.metrics();
      expect(metrics).toContain("provider_token_usage_total");
      expect(metrics).toContain('type="prompt"');
      expect(metrics).toContain('type="completion"');
      expect(metrics).toContain('type="total"');
    });

    it("should handle partial token data", async () => {
      recordTokenUsage(
        {
          provider: "test-provider",
          model: "test-model",
        },
        {
          totalTokens: 150,
        }
      );

      const metrics = await register.metrics();
      expect(metrics).toContain('type="total"');
    });

    it("should skip zero values", async () => {
      recordTokenUsage(
        {
          provider: "test-provider",
          model: "test-model",
        },
        {
          promptTokens: 0,
          completionTokens: 50,
        }
      );

      const metrics = await register.metrics();
      // Should only record completion tokens
      expect(metrics).toContain('type="completion"');
    });
  });

  describe("Cache metrics", () => {
    it("should record cache hits", async () => {
      recordCacheHit({
        provider: "test-provider",
        model: "test-model",
      });

      const metrics = await register.metrics();
      expect(metrics).toContain("provider_cache_hits_total");
    });

    it("should record cache misses", async () => {
      recordCacheMiss({
        provider: "test-provider",
        model: "test-model",
      });

      const metrics = await register.metrics();
      expect(metrics).toContain("provider_cache_misses_total");
    });
  });

  describe("recordRateLimit", () => {
    it("should record rate limit encounters", async () => {
      recordRateLimit({
        provider: "test-provider",
        model: "test-model",
      });

      const metrics = await register.metrics();
      expect(metrics).toContain("provider_rate_limit_hits_total");
    });
  });

  describe("updateCircuitBreakerState", () => {
    it("should set circuit breaker state", async () => {
      updateCircuitBreakerState("test-provider", 0); // closed
      updateCircuitBreakerState("test-provider", 1); // open
      updateCircuitBreakerState("test-provider", 2); // half-open

      const metrics = await register.metrics();
      expect(metrics).toContain("provider_circuit_breaker_state");
    });
  });

  describe("Active requests gauge", () => {
    it("should increment and decrement active requests", async () => {
      const endTracking1 = startProviderRequest({
        provider: "test-provider",
        model: "test-model",
        operation: "chat",
      });

      const endTracking2 = startProviderRequest({
        provider: "test-provider",
        model: "test-model",
        operation: "chat",
      });

      let metrics = await register.metrics();
      expect(metrics).toContain("provider_active_requests");

      endTracking1();
      endTracking2();

      metrics = await register.metrics();
      // Gauge should be back to 0 or not present
      expect(metrics).toContain("provider_active_requests");
    });
  });

  describe("Tenant labeling", () => {
    it("should include tenant ID in labels", async () => {
      const timer = new ProviderRequestTimer({
        provider: "test-provider",
        model: "test-model",
        operation: "chat",
        tenantId: "tenant-123",
      });

      timer.success({});

      const metrics = await register.metrics();
      expect(metrics).toContain('tenant="tenant-123"');
    });

    it("should use default tenant when not provided", async () => {
      const timer = new ProviderRequestTimer({
        provider: "test-provider",
        model: "test-model",
        operation: "chat",
      });

      timer.success({});

      const metrics = await register.metrics();
      expect(metrics).toContain("tenant=");
    });
  });

  describe("Metric name conventions", () => {
    it("should follow Prometheus naming conventions", async () => {
      const timer = new ProviderRequestTimer({
        provider: "test-provider",
        model: "test-model",
        operation: "chat",
      });

      timer.success({});

      const metrics = await register.metrics();

      // All metric names should be lowercase with underscores
      expect(metrics).toMatch(/provider_[a-z_]+/);

      // Duration should be in seconds
      expect(metrics).toContain("_seconds");

      // Counters should end with _total
      expect(metrics).toContain("_total");
    });
  });

  describe("Performance", () => {
    it("should handle high-frequency metrics updates", async () => {
      const iterations = 1000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        const timer = new ProviderRequestTimer({
          provider: "test-provider",
          model: "test-model",
          operation: "chat",
        });

        timer.success({
          promptTokens: 10,
          completionTokens: 10,
          totalTokens: 20,
        });
      }

      const duration = Date.now() - start;
      const avgTime = duration / iterations;

      // Should be very fast (< 1ms per operation)
      expect(avgTime).toBeLessThan(1);
    });
  });

  describe("Error handling", () => {
    it("should handle invalid metric values gracefully", () => {
      expect(() => {
        recordTokenUsage(
          { provider: "test", model: "test" },
          { promptTokens: -1 }
        );
      }).not.toThrow();

      expect(() => {
        updateCircuitBreakerState("test", 99); // Invalid state
      }).not.toThrow();
    });
  });
});
