/**
 * ApprovalManager test suite
 * Tests approval workflows, timeout handling, batch operations, and audit trails
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pino } from "pino";
import {
  ApprovalManager,
  ApprovalStatus,
  ApprovalRequest,
  ApprovalConfig,
  ApprovalData,
  BatchApprovalRequest,
} from "./ApprovalManager";

// Create a test logger
const testLogger = pino({ level: "silent" });

describe("ApprovalManager", () => {
  let manager: ApprovalManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new ApprovalManager(testLogger);
  });

  afterEach(() => {
    manager.shutdown();
    vi.useRealTimers();
  });

  describe("initialization", () => {
    it("should initialize with default configuration", () => {
      const defaultManager = new ApprovalManager(testLogger);
      expect(defaultManager).toBeDefined();
      defaultManager.shutdown();
    });

    it("should initialize with custom configuration", () => {
      const config: ApprovalConfig = {
        defaultTimeout: 60000,
        maxPendingPerTenant: 50,
        autoDenyOnTimeout: false,
        enableBatchApprovals: false,
        auditEnabled: false,
      };

      const customManager = new ApprovalManager(testLogger, config);
      expect(customManager).toBeDefined();
      customManager.shutdown();
    });

    it("should start cleanup interval on initialization", () => {
      const setIntervalSpy = vi.spyOn(global, "setInterval");
      const manager = new ApprovalManager(testLogger);

      expect(setIntervalSpy).toHaveBeenCalled();

      manager.shutdown();
    });
  });

  describe("requestApproval", () => {
    it("should create a new approval request", async () => {
      const operation = "delete_database";
      const reason = "User requested database deletion";
      const details: ApprovalData = {
        database: "production",
        user: "admin",
      };

      const approvalPromise = manager.requestApproval(operation, reason, details);

      // Get the request
      const pending = manager.getPendingRequests();
      expect(pending).toHaveLength(1);
      expect(pending[0].operation).toBe(operation);
      expect(pending[0].reason).toBe(reason);
      expect(pending[0].details).toEqual(details);
      expect(pending[0].status).toBe(ApprovalStatus.PENDING);

      // Approve it
      manager.approve(pending[0].id);

      const result = await approvalPromise;
      expect(result).toBe(true);
    });

    it("should handle approval with metadata", async () => {
      const approvalPromise = manager.requestApproval(
        "operation",
        "reason",
        { key: "value" },
        {
          requesterId: "user-123",
          tenantId: "tenant-456",
          metadata: { priority: "high" },
        }
      );

      const pending = manager.getPendingRequests();
      expect(pending[0].requesterId).toBe("user-123");
      expect(pending[0].tenantId).toBe("tenant-456");
      expect(pending[0].metadata).toEqual({ priority: "high" });

      manager.approve(pending[0].id);
      await approvalPromise;
    });

    it("should respect custom timeout", async () => {
      const customTimeout = 1000; // 1 second

      const approvalPromise = manager.requestApproval(
        "operation",
        "reason",
        {},
        { timeout: customTimeout }
      );

      // Advance time past timeout
      vi.advanceTimersByTime(customTimeout + 100);

      const result = await approvalPromise;
      expect(result).toBe(false); // Auto-denied on timeout
    });

    it("should enforce tenant limits", async () => {
      const limitedManager = new ApprovalManager(testLogger, {
        maxPendingPerTenant: 2,
      });

      const tenantId = "tenant-123";

      // Create 2 requests (at limit)
      // We catch errors to prevent unhandled rejections, but we expect these to succeed (stay pending)
      const p1 = limitedManager.requestApproval("op1", "reason", {}, { tenantId }).catch(() => false);
      const p2 = limitedManager.requestApproval("op2", "reason", {}, { tenantId }).catch(() => false);

      // Verify we hit the limit
      expect(limitedManager.getPendingRequests(tenantId)).toHaveLength(2);

      // Third request should fail
      await expect(
        limitedManager.requestApproval("op3", "reason", {}, { tenantId })
      ).rejects.toThrow("Too many pending approval requests");

      // Cleanup: Cancel pending requests to resolve promises
      const pending = limitedManager.getPendingRequests(tenantId);
      pending.forEach(req => limitedManager.cancel(req.id));

      // Wait for promises to settle
      await Promise.allSettled([p1, p2]);

      limitedManager.shutdown();
    });

    it("should emit requested event", async () => {
      const requestedListener = vi.fn();
      manager.on("requested", requestedListener);

      const approvalPromise = manager.requestApproval("op", "reason", {});

      expect(requestedListener).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            operation: "op",
            reason: "reason",
          }),
        })
      );

      const pending = manager.getPendingRequests();
      manager.approve(pending[0].id);
      await approvalPromise;
    });
  });

  describe("approve", () => {
    let requestId: string;

    beforeEach(async () => {
      const approvalPromise = manager.requestApproval("op", "reason", {});
      const pending = manager.getPendingRequests();
      requestId = pending[0].id;

      // Don't wait for the promise to avoid blocking
      approvalPromise.catch(() => { }); // Suppress unhandled rejection
    });

    it("should approve a pending request", () => {
      const result = manager.approve(requestId, "approver", "Looks good");
      expect(result).toBe(true);

      const request = manager.getRequest(requestId);
      expect(request?.status).toBe(ApprovalStatus.APPROVED);
      expect(request?.resolvedBy).toBe("approver");
      expect(request?.resolutionComment).toBe("Looks good");
      expect(request?.resolvedAt).toBeDefined();
    });

    it("should emit denied event", () => {
      const deniedListener = vi.fn();
      manager.on("denied", deniedListener);

      manager.deny(requestId);

      expect(deniedListener).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            id: requestId,
            status: ApprovalStatus.DENIED,
          }),
        })
      );
    });

    it("should return false for non-existent request", () => {
      const result = manager.deny("non-existent-id");
      expect(result).toBe(false);
    });

    it("should not deny already resolved request", () => {
      manager.deny(requestId);

      // Try to deny again
      const result = manager.deny(requestId);
      expect(result).toBe(false);
    });

    it("should cancel a pending request", () => {
      const result = manager.cancel(requestId);
      expect(result).toBe(true);

      const request = manager.getRequest(requestId);
      expect(request?.status).toBe(ApprovalStatus.CANCELLED);
      expect(request?.resolvedAt).toBeDefined();
    });

    it("should emit cancelled event", () => {
      const cancelledListener = vi.fn();
      manager.on("cancelled", cancelledListener);

      manager.cancel(requestId);

      expect(cancelledListener).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            id: requestId,
            status: ApprovalStatus.CANCELLED,
          }),
        })
      );
    });

    it("should return false for non-existent request", () => {
      const result = manager.cancel("non-existent-id");
      expect(result).toBe(false);
    });

    it("should not cancel already resolved request", () => {
      manager.approve(requestId);

      const result = manager.cancel(requestId);
      expect(result).toBe(false);
    });
  });

  describe("timeout handling", () => {
    it("should auto-deny on timeout when configured", async () => {
      const manager = new ApprovalManager(testLogger, {
        defaultTimeout: 1000,
        autoDenyOnTimeout: true,
      });

      const approvalPromise = manager.requestApproval("op", "reason", {});

      // Advance time past timeout
      vi.advanceTimersByTime(1100);

      const result = await approvalPromise;
      expect(result).toBe(false);

      const pending = manager.getPendingRequests();
      expect(pending).toHaveLength(0); // No longer pending

      manager.shutdown();
    });

    it("should reject on timeout when auto-deny is disabled", async () => {
      const manager = new ApprovalManager(testLogger, {
        defaultTimeout: 1000,
        autoDenyOnTimeout: false,
      });

      const approvalPromise = manager.requestApproval("op", "reason", {});

      // Advance time past timeout
      vi.advanceTimersByTime(1100);

      await expect(approvalPromise).rejects.toThrow("Approval request timed out");

      manager.shutdown();
    });

    it("should emit expired event on timeout", async () => {
      const expiredListener = vi.fn();
      manager.on("expired", expiredListener);

      const approvalPromise = manager.requestApproval("op", "reason", {}, {
        timeout: 1000,
      });

      vi.advanceTimersByTime(1100);

      await approvalPromise;

      expect(expiredListener).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            status: ApprovalStatus.EXPIRED,
          }),
        })
      );
    });

    it("should clear timeout on approval", async () => {
      const approvalPromise = manager.requestApproval("op", "reason", {}, {
        timeout: 1000,
      });

      const pending = manager.getPendingRequests();

      // Approve before timeout
      manager.approve(pending[0].id);

      const result = await approvalPromise;
      expect(result).toBe(true);

      // Advance time past where timeout would have been
      vi.advanceTimersByTime(2000);

      // Request should still be approved, not expired
      const request = manager.getRequest(pending[0].id);
      expect(request?.status).toBe(ApprovalStatus.APPROVED);
    });
  });

  describe("batch operations", () => {
    it("should create a batch approval request", () => {
      const requests = [
        { operation: "op1", reason: "reason1", details: { key1: "value1" } as ApprovalData },
        { operation: "op2", reason: "reason2", details: { key2: "value2" } as ApprovalData },
        { operation: "op3", reason: "reason3", details: { key3: "value3" } as ApprovalData },
      ];

      const batchId = manager.createBatch(requests, "Batch description");

      expect(batchId).toBeDefined();

      const batch = manager.getBatch(batchId);
      expect(batch).toBeDefined();
      expect(batch?.requests).toHaveLength(3);
      expect(batch?.description).toBe("Batch description");

      // Individual requests should be added
      const pending = manager.getPendingRequests();
      expect(pending).toHaveLength(3);
    });

    it("should approve all requests in a batch", () => {
      const requests = [
        { operation: "op1", reason: "reason1", details: {} },
        { operation: "op2", reason: "reason2", details: {} },
      ];

      const batchId = manager.createBatch(requests, "Test batch");

      const approved = manager.approveBatch(batchId, "approver", "Batch approved");

      expect(approved).toBe(2);

      const batch = manager.getBatch(batchId);
      batch?.requests.forEach(req => {
        const request = manager.getRequest(req.id);
        expect(request?.status).toBe(ApprovalStatus.APPROVED);
        expect(request?.resolvedBy).toBe("approver");
      });
    });

    it("should deny all requests in a batch", () => {
      const requests = [
        { operation: "op1", reason: "reason1", details: {} },
        { operation: "op2", reason: "reason2", details: {} },
      ];

      const batchId = manager.createBatch(requests, "Test batch");

      const denied = manager.denyBatch(batchId, "denier", "Batch denied");

      expect(denied).toBe(2);

      const batch = manager.getBatch(batchId);
      batch?.requests.forEach(req => {
        const request = manager.getRequest(req.id);
        expect(request?.status).toBe(ApprovalStatus.DENIED);
        expect(request?.resolvedBy).toBe("denier");
      });
    });

    it("should emit batch events", () => {
      const batchCreatedListener = vi.fn();
      const batchApprovedListener = vi.fn();

      manager.on("batchCreated", batchCreatedListener);
      manager.on("batchApproved", batchApprovedListener);

      const batchId = manager.createBatch(
        [{ operation: "op", reason: "reason", details: {} }],
        "Test"
      );

      expect(batchCreatedListener).toHaveBeenCalled();

      manager.approveBatch(batchId);

      expect(batchApprovedListener).toHaveBeenCalledWith(
        expect.objectContaining({
          batchId,
          approved: 1,
        })
      );
    });

    it("should handle partial batch approval", () => {
      const requests = [
        { operation: "op1", reason: "reason1", details: {} },
        { operation: "op2", reason: "reason2", details: {} },
      ];

      const batchId = manager.createBatch(requests, "Test batch");
      const batch = manager.getBatch(batchId);

      // Approve one request individually
      manager.approve(batch!.requests[0].id);

      // Try to approve the batch
      const approved = manager.approveBatch(batchId);

      // Only one should be approved (the second one)
      expect(approved).toBe(1);
    });

    it("should throw error when batch approvals are disabled", () => {
      const manager = new ApprovalManager(testLogger, {
        enableBatchApprovals: false,
      });

      expect(() =>
        manager.createBatch(
          [{ operation: "op", reason: "reason", details: {} }],
          "Test"
        )
      ).toThrow("Batch approvals are disabled");

      manager.shutdown();
    });
  });

  describe("getPendingRequests", () => {
    it("should return all pending requests", async () => {
      // Create multiple requests
      const promises = [
        manager.requestApproval("op1", "reason", {}),
        manager.requestApproval("op2", "reason", {}),
        manager.requestApproval("op3", "reason", {}),
      ];

      const pending = manager.getPendingRequests();
      expect(pending).toHaveLength(3);

      // Approve one
      manager.approve(pending[0].id);

      const stillPending = manager.getPendingRequests();
      expect(stillPending).toHaveLength(2);

      // Cleanup
      stillPending.forEach(req => manager.approve(req.id));
      await Promise.all(promises);
    });

    it("should filter by tenant", async () => {
      const promises = [
        manager.requestApproval("op1", "reason", {}, { tenantId: "tenant-a" }),
        manager.requestApproval("op2", "reason", {}, { tenantId: "tenant-b" }),
        manager.requestApproval("op3", "reason", {}, { tenantId: "tenant-a" }),
      ];

      const tenantAPending = manager.getPendingRequests("tenant-a");
      expect(tenantAPending).toHaveLength(2);

      const tenantBPending = manager.getPendingRequests("tenant-b");
      expect(tenantBPending).toHaveLength(1);

      // Cleanup
      manager.getPendingRequests().forEach(req => manager.approve(req.id));
      await Promise.all(promises);
    });
  });

  describe("getStats", () => {
    it("should return approval statistics", async () => {
      // Create various requests
      const promises = [];

      // Create and approve
      const p1 = manager.requestApproval("op1", "reason", {});
      const pending1 = manager.getPendingRequests();
      manager.approve(pending1[0].id);
      promises.push(p1);

      // Create and deny
      const p2 = manager.requestApproval("op2", "reason", {});
      const pending2 = manager.getPendingRequests();
      manager.deny(pending2[0].id);
      promises.push(p2);

      // Create and cancel
      const p3 = manager.requestApproval("op3", "reason", {});
      const pending3 = manager.getPendingRequests();
      manager.cancel(pending3[0].id);
      promises.push(p3);

      // Create and leave pending
      // We don't await this one as it stays pending
      manager.requestApproval("op4", "reason", {}).catch(() => { });

      // Create and let expire
      const p5 = manager.requestApproval("op5", "reason", {}, { timeout: 100 });
      vi.advanceTimersByTime(200);
      promises.push(p5);

      await Promise.allSettled(promises);

      const stats = manager.getStats();

      expect(stats.approved).toBe(1);
      expect(stats.denied).toBe(1);
      expect(stats.cancelled).toBe(1);
      expect(stats.pending).toBe(1);
      expect(stats.expired).toBe(1);
    });

    it("should filter statistics by tenant", async () => {
      const promises = [];

      // Create requests
      const p1 = manager.requestApproval("op1", "reason", {}, { tenantId: "tenant-a" });
      const p2 = manager.requestApproval("op2", "reason", {}, { tenantId: "tenant-b" });
      const p3 = manager.requestApproval("op3", "reason", {}, { tenantId: "tenant-a" });

      promises.push(p1, p2, p3);

      const pending = manager.getPendingRequests();
      const tenantARequest = pending.find(r => r.tenantId === "tenant-a");
      const tenantBRequest = pending.find(r => r.tenantId === "tenant-b");

      expect(tenantARequest).toBeDefined();
      expect(tenantBRequest).toBeDefined();

      if (tenantARequest) manager.approve(tenantARequest.id);
      if (tenantBRequest) manager.deny(tenantBRequest.id);

      // We don't await all promises because p3 stays pending
      // We only await the ones we resolved
      await Promise.allSettled([p1, p2]);

      const statsA = manager.getStats("tenant-a");
      expect(statsA.approved).toBe(1);
      expect(statsA.pending).toBe(1);
      expect(statsA.denied).toBe(0);

      const statsB = manager.getStats("tenant-b");
      expect(statsB.denied).toBe(1);
      expect(statsB.pending).toBe(0);
      expect(statsB.approved).toBe(0);
    });
  });

  describe("cleanup", () => {
    it("should clean up expired requests periodically", async () => {
      vi.useRealTimers();

      // Create a request with very short timeout
      const approvalPromise = manager.requestApproval("op", "reason", {}, { timeout: 10 });

      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 50));

      // Manually trigger cleanup
      (manager as any).cleanupExpired();

      // The request should have timed out and resolved to false
      await expect(approvalPromise).resolves.toBe(false);

      // Check that expired event was emitted and stats updated
      const stats = manager.getStats();
      expect(stats.expired).toBe(1);

      vi.useFakeTimers();
    });

    it("should remove old resolved requests", async () => {
      const approvalPromise = manager.requestApproval("op", "reason", {});
      const pending = manager.getPendingRequests();
      const requestId = pending[0].id;

      manager.approve(requestId);
      await approvalPromise;

      // Request should exist
      expect(manager.getRequest(requestId)).toBeDefined();

      // Advance time past 1 hour
      vi.advanceTimersByTime(3600000 + 60000); // 1 hour + cleanup interval

      // Request should be removed
      expect(manager.getRequest(requestId)).toBeUndefined();
    });
  });

  describe("shutdown", () => {
    it("should clear all data and stop intervals", () => {
      const clearIntervalSpy = vi.spyOn(global, "clearInterval");

      // Create some requests
      manager.requestApproval("op1", "reason", {});
      manager.requestApproval("op2", "reason", {});
      manager.createBatch(
        [{ operation: "op", reason: "reason", details: {} }],
        "Test"
      );

      manager.shutdown();

      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(manager.getPendingRequests()).toHaveLength(0);
      expect(manager.getStats().pending).toBe(0);
    });
  });

  describe("event handling", () => {
    it("should handle multiple listeners correctly", async () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      manager.on("approved", listener1);
      manager.on("approved", listener2);

      const approvalPromise = manager.requestApproval("op", "reason", {});
      const pending = manager.getPendingRequests();

      manager.approve(pending[0].id);
      await approvalPromise;

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it("should remove listeners correctly", async () => {
      const listener = vi.fn();

      manager.on("approved", listener);
      manager.off("approved", listener);

      const approvalPromise = manager.requestApproval("op", "reason", {});
      const pending = manager.getPendingRequests();

      manager.approve(pending[0].id);
      await approvalPromise;

      expect(listener).not.toHaveBeenCalled();
    });
  });
});
