import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  AuditedCMEKRotationService,
  createCronJobContext,
  createManualContext,
  createApiContext,
} from "./AuditedCMEKRotation.js";
import * as audit from "../observability/audit.js";

class MockTenantKeyManager {
  public rotationCount = 0;
  public failNext = false;
  private keyVersions = new Map<string, number>();

  async rotateTenantKey(tenantId: string): Promise<string> {
    this.rotationCount++;

    if (this.failNext) {
      this.failNext = false;
      throw new Error("Mock rotation failure");
    }

    const currentVersion = this.keyVersions.get(tenantId) || 0;
    const newVersion = currentVersion + 1;
    this.keyVersions.set(tenantId, newVersion);

    return `v${newVersion}`;
  }

  getTenantKey(tenantId: string): { version: string } | undefined {
    const version = this.keyVersions.get(tenantId);
    return version ? { version: `v${version}` } : undefined;
  }

  setFailNext(): void {
    this.failNext = true;
  }
}

describe("AuditedCMEKRotationService", () => {
  let keyManager: MockTenantKeyManager;
  let service: AuditedCMEKRotationService;
  let logAuditEventSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    keyManager = new MockTenantKeyManager();
    service = new AuditedCMEKRotationService(keyManager as any);
    logAuditEventSpy = vi.spyOn(audit, "logAuditEvent");
    logAuditEventSpy.mockClear();
  });

  describe("Single Tenant Rotation", () => {
    it("should rotate tenant key with full audit trail", async () => {
      const context = createCronJobContext();
      const result = await service.rotateTenantKey("tenant-1", context);

      expect(result.success).toBe(true);
      expect(result.tenantId).toBe("tenant-1");
      expect(result.version).toBe("v1");
      expect(result.rotationId).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // Should log 2 audit events: initiated and completed
      expect(logAuditEventSpy).toHaveBeenCalledTimes(2);

      const initiatedEvent = logAuditEventSpy.mock.calls[0][0];
      expect(initiatedEvent.action).toBe("cmek.rotation.initiated");
      expect(initiatedEvent.outcome).toBe("success");
      expect(initiatedEvent.resource).toBe("tenant/tenant-1/cmek");
      expect(initiatedEvent.agent).toBe("automated-cronjob");
      expect(initiatedEvent.details?.reason).toBe("scheduled-rotation");

      const completedEvent = logAuditEventSpy.mock.calls[1][0];
      expect(completedEvent.action).toBe("cmek.rotation.completed");
      expect(completedEvent.outcome).toBe("success");
      expect(completedEvent.details?.newKeyVersion).toBe("v1");
    });

    it("should include previous version in audit log", async () => {
      // First rotation
      await service.rotateTenantKey("tenant-2", createCronJobContext());
      logAuditEventSpy.mockClear();

      // Second rotation
      const result = await service.rotateTenantKey(
        "tenant-2",
        createCronJobContext(),
      );

      expect(result.version).toBe("v2");
      expect(result.previousVersion).toBe("v1");

      const completedEvent = logAuditEventSpy.mock.calls[1][0];
      expect(completedEvent.details?.previousKeyVersion).toBe("v1");
      expect(completedEvent.details?.newKeyVersion).toBe("v2");
    });

    it("should log failure with error details", async () => {
      keyManager.setFailNext();
      const context = createCronJobContext();
      const result = await service.rotateTenantKey("tenant-fail", context);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Mock rotation failure");

      // Should log 2 events: initiated and failed
      expect(logAuditEventSpy).toHaveBeenCalledTimes(2);

      const failedEvent = logAuditEventSpy.mock.calls[1][0];
      expect(failedEvent.action).toBe("cmek.rotation.failed");
      expect(failedEvent.outcome).toBe("failure");
      expect(failedEvent.error).toBe("Mock rotation failure");
      expect(failedEvent.details?.errorType).toBe("Error");
    });

    it("should include custom metadata in audit logs", async () => {
      const context = createManualContext(
        "user-123",
        "compliance-requirement",
        {
          ticketId: "COMP-456",
          approvedBy: "security-team",
        },
      );

      await service.rotateTenantKey("tenant-meta", context);

      const initiatedEvent = logAuditEventSpy.mock.calls[0][0];
      expect(initiatedEvent.agent).toBe("manual-operation");
      expect(initiatedEvent.subject?.userId).toBeDefined(); // Hashed
      expect(initiatedEvent.details?.reason).toBe("compliance-requirement");
      expect(initiatedEvent.details?.ticketId).toBe("COMP-456");
      expect(initiatedEvent.details?.approvedBy).toBe("security-team");
    });
  });

  describe("Batch Rotation", () => {
    it("should rotate multiple tenants with batch audit events", async () => {
      const context = createCronJobContext();
      const results = await service.rotateBatch(
        ["tenant-a", "tenant-b", "tenant-c"],
        context,
      );

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.success)).toBe(true);

      // Batch events: 1 start + 3x(initiated+completed) + 1 complete = 8 events
      expect(logAuditEventSpy).toHaveBeenCalledTimes(8);

      const batchStartEvent = logAuditEventSpy.mock.calls[0][0];
      expect(batchStartEvent.action).toBe("cmek.rotation.batch.start");
      expect(batchStartEvent.details?.tenantCount).toBe(3);

      const batchCompleteEvent = logAuditEventSpy.mock.calls[7][0];
      expect(batchCompleteEvent.action).toBe("cmek.rotation.batch.complete");
      expect(batchCompleteEvent.outcome).toBe("success");
      expect(batchCompleteEvent.details?.successful).toBe(3);
      expect(batchCompleteEvent.details?.failed).toBe(0);
    });

    it("should handle partial batch failures", async () => {
      const context = createCronJobContext();

      // Make second rotation fail
      keyManager.rotationCount = 0;
      const originalRotate = keyManager.rotateTenantKey.bind(keyManager);
      keyManager.rotateTenantKey = async function (tenantId: string) {
        const currentCount = keyManager.rotationCount++;
        if (currentCount === 1) {
          // Second call (after incrementing count)
          throw new Error("Simulated failure");
        }
        // Decrement since originalRotate will increment again
        keyManager.rotationCount--;
        return originalRotate(tenantId);
      };

      const results = await service.rotateBatch(
        ["tenant-1", "tenant-2", "tenant-3"],
        context,
      );

      expect(results).toHaveLength(3);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[2].success).toBe(true);

      const batchCompleteEvent =
        logAuditEventSpy.mock.calls[logAuditEventSpy.mock.calls.length - 1][0];
      expect(batchCompleteEvent.action).toBe("cmek.rotation.batch.complete");
      expect(batchCompleteEvent.outcome).toBe("failure"); // Has failures
      expect(batchCompleteEvent.details?.successful).toBe(2);
      expect(batchCompleteEvent.details?.failed).toBe(1);
      expect(batchCompleteEvent.details?.failedTenants).toHaveLength(1);
      expect(batchCompleteEvent.details?.failedTenants[0]).toMatchObject({
        tenantId: "tenant-2",
        error: "Simulated failure",
      });
    });

    it("should include batchId in individual rotation metadata", async () => {
      const context = createCronJobContext();
      await service.rotateBatch(["tenant-batch-1"], context);

      // Find an individual rotation initiated event
      const individualInitiated = logAuditEventSpy.mock.calls.find(
        (call: any) =>
          call[0].action === "cmek.rotation.initiated" &&
          call[0].resource === "tenant/tenant-batch-1/cmek",
      );

      expect(individualInitiated).toBeDefined();
      expect(individualInitiated![0].details?.batchId).toBeDefined();
      expect(individualInitiated![0].details?.batchSize).toBe(1);
    });
  });

  describe("Context Builders", () => {
    it("should create CronJob context with correct fields", () => {
      const context = createCronJobContext("weekly-rotation");

      expect(context.initiator).toBe("automated-cronjob");
      expect(context.reason).toBe("weekly-rotation");
      expect(context.metadata?.automation).toBe(true);
    });

    it("should create manual context with user subject", () => {
      const context = createManualContext("admin-user", "emergency-rotation", {
        urgency: "high",
      });

      expect(context.initiator).toBe("manual-operation");
      expect(context.reason).toBe("emergency-rotation");
      expect(context.subject?.userId).toBe("admin-user");
      expect(context.metadata?.urgency).toBe("high");
      expect(context.metadata?.automation).toBe(false);
    });

    it("should create API context with full subject", () => {
      const subject = {
        sessionId: "sess-123",
        userId: "api-user",
        tenantId: "tenant-api",
        email: "api@example.com",
        roles: ["admin"],
      };

      const context = createApiContext(subject, "api-triggered", "req-456");

      expect(context.initiator).toBe("api-request");
      expect(context.reason).toBe("api-triggered");
      expect(context.subject).toEqual(subject);
      expect(context.metadata?.requestId).toBe("req-456");
    });
  });

  describe("Audit Event Structure", () => {
    it("should include all required audit fields", async () => {
      const context = createCronJobContext();
      await service.rotateTenantKey("tenant-audit", context);

      const event = logAuditEventSpy.mock.calls[0][0];

      // Required audit fields
      expect(event.action).toBeDefined();
      expect(event.outcome).toBeDefined();
      expect(event.resource).toBeDefined();
      expect(event.agent).toBeDefined();
      expect(event.details).toBeDefined();
    });

    it("should include rotationId for correlation", async () => {
      const context = createCronJobContext();
      await service.rotateTenantKey("tenant-corr", context);

      const initiatedEvent = logAuditEventSpy.mock.calls[0][0];
      const completedEvent = logAuditEventSpy.mock.calls[1][0];

      expect(initiatedEvent.details?.rotationId).toBeDefined();
      expect(completedEvent.details?.rotationId).toBeDefined();
      expect(initiatedEvent.details?.rotationId).toBe(
        completedEvent.details?.rotationId,
      );
    });

    it("should include timestamps for all events", async () => {
      const context = createCronJobContext();
      await service.rotateTenantKey("tenant-time", context);

      for (const call of logAuditEventSpy.mock.calls) {
        const event = call[0];
        expect(
          event.details?.timestamp ||
            event.details?.completedAt ||
            event.details?.failedAt,
        ).toBeDefined();
      }
    });
  });
});
