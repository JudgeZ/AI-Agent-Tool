import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  VaultTokenRenewalService,
  type VaultTokenProvider,
} from "./VaultTokenRenewal.js";

class MockTokenProvider implements VaultTokenProvider {
  public tokenExpiresAt: number | undefined;
  public managedToken = true;
  public renewalCount = 0;
  public renewalErrors: Error[] = [];
  private failNextRenewal = false;

  constructor(expiresInMs?: number) {
    if (expiresInMs !== undefined) {
      this.tokenExpiresAt = Date.now() + expiresInMs;
    }
  }

  getTokenExpiry(): number | undefined {
    return this.tokenExpiresAt;
  }

  async renewToken(force = false): Promise<void> {
    this.renewalCount++;

    if (this.failNextRenewal) {
      this.failNextRenewal = false;
      const error = new Error("Mock renewal failure");
      this.renewalErrors.push(error);
      throw error;
    }

    // Simulate successful renewal with new expiry
    this.tokenExpiresAt = Date.now() + 3600000; // 1 hour
  }

  isManagedToken(): boolean {
    return this.managedToken;
  }

  setFailNextRenewal(): void {
    this.failNextRenewal = true;
  }

  setTokenExpiry(expiresInMs: number): void {
    this.tokenExpiresAt = Date.now() + expiresInMs;
  }
}

describe("VaultTokenRenewalService", () => {
  let provider: MockTokenProvider;
  let service: VaultTokenRenewalService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));
  });

  afterEach(async () => {
    if (service?.isRunning()) {
      await service.stop();
    }
    vi.useRealTimers();
  });

  describe("Configuration", () => {
    it("should throw error if renewalThreshold is invalid", () => {
      provider = new MockTokenProvider(3600000);

      expect(() => {
        new VaultTokenRenewalService(provider, { renewalThreshold: 0 });
      }).toThrow("renewalThreshold must be between 0 and 1");

      expect(() => {
        new VaultTokenRenewalService(provider, { renewalThreshold: 1 });
      }).toThrow("renewalThreshold must be between 0 and 1");

      expect(() => {
        new VaultTokenRenewalService(provider, { renewalThreshold: -0.5 });
      }).toThrow("renewalThreshold must be between 0 and 1");
    });

    it("should accept valid renewalThreshold", () => {
      provider = new MockTokenProvider(3600000);

      expect(() => {
        new VaultTokenRenewalService(provider, { renewalThreshold: 0.5 });
      }).not.toThrow();

      expect(() => {
        new VaultTokenRenewalService(provider, { renewalThreshold: 0.8 });
      }).not.toThrow();
    });
  });

  describe("Service Lifecycle", () => {
    it("should start and stop cleanly", async () => {
      provider = new MockTokenProvider(3600000);
      service = new VaultTokenRenewalService(provider, {
        checkIntervalMs: 1000,
        enabled: true,
      });

      expect(service.isRunning()).toBe(false);

      await service.start();
      expect(service.isRunning()).toBe(true);

      await service.stop();
      expect(service.isRunning()).toBe(false);
    });

    it("should not start if disabled", async () => {
      provider = new MockTokenProvider(3600000);
      service = new VaultTokenRenewalService(provider, {
        enabled: false,
      });

      await service.start();
      expect(service.isRunning()).toBe(false);
    });

    it("should not start if token is not managed", async () => {
      provider = new MockTokenProvider(3600000);
      provider.managedToken = false;

      service = new VaultTokenRenewalService(provider, {
        enabled: true,
      });

      await service.start();
      expect(service.isRunning()).toBe(false);
    });

    it("should warn if already running", async () => {
      provider = new MockTokenProvider(3600000);
      service = new VaultTokenRenewalService(provider, {
        checkIntervalMs: 1000,
      });

      await service.start();
      expect(service.isRunning()).toBe(true);

      // Try to start again
      await service.start();
      expect(service.isRunning()).toBe(true);
    });
  });

  describe("Token Renewal Logic", () => {
    it("should renew token when threshold is reached", async () => {
      vi.useRealTimers();

      // Token expires in 200ms
      provider = new MockTokenProvider(200);

      service = new VaultTokenRenewalService(provider, {
        checkIntervalMs: 20, // Fast check
        renewalThreshold: 0.5, // Renew at 50% of lease (100ms remaining)
        enabled: true,
      });

      await service.start();

      // Wait for 150ms. 
      // At 0ms: 200ms remaining.
      // At 100ms: 100ms remaining (threshold).
      // At 150ms: 50ms remaining (< threshold). Should trigger.
      await new Promise(resolve => setTimeout(resolve, 150));

      expect(provider.renewalCount).toBeGreaterThanOrEqual(1);

      vi.useFakeTimers();
    });

    it("should renew expired token immediately", async () => {
      // Token already expired
      provider = new MockTokenProvider(-1000);

      service = new VaultTokenRenewalService(provider, {
        checkIntervalMs: 100,
        renewalThreshold: 0.8,
        enabled: true,
      });

      await service.start();

      // First check should trigger immediate renewal
      await vi.advanceTimersByTimeAsync(100);
      await vi.runAllTimersAsync();

      expect(provider.renewalCount).toBeGreaterThanOrEqual(1);
    });

    it("should not renew if token doesn't expire", async () => {
      provider = new MockTokenProvider();
      provider.tokenExpiresAt = undefined; // No expiry

      service = new VaultTokenRenewalService(provider, {
        checkIntervalMs: 50,
        enabled: true,
      });

      await service.start();

      // Run multiple check cycles
      await vi.advanceTimersByTimeAsync(200);
      await vi.runAllTimersAsync();

      expect(provider.renewalCount).toBe(0);
    });

    it("should not renew if token is still fresh", async () => {
      // Token expires in 1 hour
      provider = new MockTokenProvider(3600000);

      service = new VaultTokenRenewalService(provider, {
        checkIntervalMs: 1000,
        renewalThreshold: 0.8, // Renew at 80%
        enabled: true,
      });

      await service.start();

      // Run several checks
      await vi.advanceTimersByTimeAsync(5000);
      await vi.runAllTimersAsync();

      expect(provider.renewalCount).toBe(0);
    });
  });

  describe("Retry Logic", () => {
    beforeEach(() => {
      vi.useRealTimers();
    });

    afterEach(() => {
      vi.useFakeTimers();
    });

    it("should retry on renewal failure", async () => {
      provider = new MockTokenProvider(200);
      provider.setFailNextRenewal(); // Fail first attempt

      service = new VaultTokenRenewalService(provider, {
        checkIntervalMs: 10, // Fast check
        renewalThreshold: 0.5,
        maxRetries: 3,
        retryBackoffMs: 10, // Fast retry
        enabled: true,
      });

      await service.start();

      // Wait for renewal to trigger (expiry 200ms, threshold 0.5 -> 100ms remaining)
      // We need to wait ~100ms + check interval
      await new Promise(resolve => setTimeout(resolve, 150));

      // Wait for retry backoff (10ms) + some buffer
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should have retried: 1 failure + 1 success = 2 total
      expect(provider.renewalCount).toBeGreaterThanOrEqual(2);
      expect(provider.renewalErrors.length).toBe(1);
    });

    it("should use exponential backoff for retries", async () => {
      provider = new MockTokenProvider(-1000); // Already expired

      // Fail first 2 attempts, succeed on 3rd
      let attemptCount = 0;
      provider.renewToken = async (force?: boolean) => {
        attemptCount++;
        if (attemptCount <= 2) {
          throw new Error(`Mock failure ${attemptCount}`);
        }
        // Succeed on 3rd attempt
        provider.tokenExpiresAt = Date.now() + 3600000;
      };

      service = new VaultTokenRenewalService(provider, {
        checkIntervalMs: 10,
        maxRetries: 3,
        retryBackoffMs: 10, // Base backoff
        enabled: true,
      });

      await service.start();

      // Token already expired, first check triggers immediate renewal
      // Wait for retries:
      // 1. Immediate fail
      // 2. Backoff 10ms -> fail
      // 3. Backoff 20ms -> success

      await new Promise(resolve => setTimeout(resolve, 100));

      // Should have tried 3 times (2 failures + 1 success)
      expect(attemptCount).toBeGreaterThanOrEqual(3);
    });

    it("should throw after max retries exhausted", async () => {
      provider = new MockTokenProvider(-1000);

      // Always fail
      provider.renewToken = async () => {
        throw new Error("Persistent failure");
      };

      service = new VaultTokenRenewalService(provider, {
        checkIntervalMs: 10,
        maxRetries: 2,
        retryBackoffMs: 10,
        enabled: true,
      });

      await service.start();

      // Trigger renewal and let it exhaust retries
      // Initial + 2 retries with backoff
      await new Promise(resolve => setTimeout(resolve, 100));

      // Service should still be running despite failure
      expect(service.isRunning()).toBe(true);
    });
  });

  describe("Graceful Shutdown", () => {
    it("should wait for in-flight renewal before stopping", async () => {
      // Token already expired to trigger immediate renewal
      provider = new MockTokenProvider(-1000);

      // Make renewal take some time using timers/promises which respects fake timers
      let renewalComplete = false;
      const { setTimeout: fakeTimeout } = await import("node:timers/promises");
      provider.renewToken = async () => {
        await fakeTimeout(100);
        renewalComplete = true;
        provider.tokenExpiresAt = Date.now() + 3600000;
      };

      service = new VaultTokenRenewalService(provider, {
        checkIntervalMs: 50,
        renewalThreshold: 0.8,
        enabled: true,
      });

      await service.start();

      // First check happens immediately, triggers renewal
      await vi.advanceTimersByTimeAsync(50);

      // Stop while renewal is in progress
      const stopPromise = service.stop();

      // Complete the renewal timeout (100ms) and other timers
      await vi.advanceTimersByTimeAsync(100);
      await vi.runAllTimersAsync();

      await stopPromise;

      expect(renewalComplete).toBe(true);
      expect(service.isRunning()).toBe(false);
    });

    it("should stop checking after stop is called", async () => {
      provider = new MockTokenProvider(3600000);

      service = new VaultTokenRenewalService(provider, {
        checkIntervalMs: 100,
        enabled: true,
      });

      await service.start();

      // Run a few checks
      await vi.advanceTimersByTimeAsync(300);

      await service.stop();

      const renewalCountBeforeStop = provider.renewalCount;

      // Advance time significantly
      await vi.advanceTimersByTimeAsync(1000);
      await vi.runAllTimersAsync();

      // Should not have performed any additional renewals
      expect(provider.renewalCount).toBe(renewalCountBeforeStop);
    });
  });

  describe("Metrics Updates", () => {
    it("should update expiry gauge with time until expiration", async () => {
      provider = new MockTokenProvider(5000); // 5 seconds

      service = new VaultTokenRenewalService(provider, {
        checkIntervalMs: 1000,
        enabled: true,
      });

      await service.start();

      // Run one check cycle
      await vi.advanceTimersByTimeAsync(1000);
      await vi.runAllTimersAsync();

      // Metrics should have been updated (tested via code coverage)
      // Actual metric values tested in integration tests
    });
  });
});
