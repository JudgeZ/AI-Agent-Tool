/**
 * Audited CMEK Rotation Module
 *
 * Provides comprehensive audit logging for Customer-Managed Encryption Key rotations.
 * All rotation events are logged for compliance and security monitoring.
 *
 * Audit Events Generated:
 * - cmek.rotation.initiated: When rotation starts
 * - cmek.rotation.completed: When rotation succeeds
 * - cmek.rotation.failed: When rotation fails
 * - cmek.rotation.batch.start: When batch rotation begins
 * - cmek.rotation.batch.complete: When batch rotation finishes
 */

import { randomUUID } from "node:crypto";
import { TenantKeyManager } from "./tenantKeys.js";
import { logAuditEvent, type AuditSubject } from "../observability/audit.js";
import { appLogger } from "../observability/logger.js";

export interface RotationAuditContext {
  initiator: string; // "manual", "automated-cronjob", "api-request", etc.
  reason?: string; // "scheduled", "compromised", "compliance", etc.
  subject?: AuditSubject;
  metadata?: Record<string, unknown>;
}

export interface RotationResult {
  tenantId: string;
  success: boolean;
  version?: string;
  previousVersion?: string;
  error?: string;
  timestamp: Date;
  rotationId: string;
  durationMs: number;
}

export class AuditedCMEKRotationService {
  constructor(private keyManager: TenantKeyManager) {}

  /**
   * Rotate CMEK for a single tenant with full audit logging
   */
  async rotateTenantKey(
    tenantId: string,
    context: RotationAuditContext,
  ): Promise<RotationResult> {
    const rotationId = randomUUID();
    const startTime = Date.now();

    try {
      appLogger.info(
        {
          event: "cmek.rotation.start",
          tenantId,
          rotationId,
          initiator: context.initiator,
        },
        `Starting audited CMEK rotation for tenant: ${tenantId}`,
      );

      // Audit: Rotation initiated
      logAuditEvent({
        action: "cmek.rotation.initiated",
        outcome: "success",
        resource: `tenant/${tenantId}/cmek`,
        agent: context.initiator,
        subject: context.subject,
        details: {
          rotationId,
          reason: context.reason,
          timestamp: new Date().toISOString(),
          ...context.metadata,
        },
      });

      // Get current version before rotation
      const previousVersion = await this.getCurrentKeyVersion(tenantId);

      // Perform rotation
      const newVersion = await this.keyManager.rotateTenantKey(tenantId);
      const duration = Date.now() - startTime;

      appLogger.info(
        {
          event: "cmek.rotation.success",
          tenantId,
          rotationId,
          previousVersion,
          newVersion,
          durationMs: duration,
        },
        `Successfully rotated CMEK for tenant ${tenantId}: v${previousVersion} → v${newVersion}`,
      );

      // Audit: Successful rotation
      logAuditEvent({
        action: "cmek.rotation.completed",
        outcome: "success",
        resource: `tenant/${tenantId}/cmek`,
        agent: context.initiator,
        subject: context.subject,
        details: {
          rotationId,
          previousKeyVersion: previousVersion,
          newKeyVersion: newVersion,
          durationMs: duration,
          completedAt: new Date().toISOString(),
          reason: context.reason,
        },
      });

      return {
        tenantId,
        success: true,
        version: newVersion, // newVersion is already a number from keyManager
        previousVersion,
        timestamp: new Date(),
        rotationId,
        durationMs: Number(duration),
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = (error as Error).message;
      const errorName = (error as Error).name;

      appLogger.error(
        {
          event: "cmek.rotation.error",
          tenantId,
          rotationId,
          error: errorMessage,
          errorType: errorName,
          durationMs: duration,
        },
        `Failed to rotate CMEK for tenant ${tenantId}: ${errorMessage}`,
      );

      // Audit: Failed rotation
      logAuditEvent({
        action: "cmek.rotation.failed",
        outcome: "failure",
        resource: `tenant/${tenantId}/cmek`,
        agent: context.initiator,
        subject: context.subject,
        error: errorMessage,
        details: {
          rotationId,
          errorType: errorName,
          durationMs: duration,
          failedAt: new Date().toISOString(),
          reason: context.reason,
        },
      });

      return {
        tenantId,
        success: false,
        error: errorMessage,
        timestamp: new Date(),
        rotationId,
        durationMs: duration,
      };
    }
  }

  /**
   * Rotate CMEK for multiple tenants with batch audit logging
   */
  async rotateBatch(
    tenantIds: string[],
    context: RotationAuditContext,
  ): Promise<RotationResult[]> {
    const batchId = randomUUID();
    const startTime = Date.now();

    appLogger.info(
      {
        event: "cmek.rotation.batch.start",
        batchId,
        tenantCount: tenantIds.length,
        initiator: context.initiator,
      },
      `Starting batch CMEK rotation for ${tenantIds.length} tenants`,
    );

    // Audit: Batch started
    logAuditEvent({
      action: "cmek.rotation.batch.start",
      outcome: "success",
      resource: "cmek/batch",
      agent: context.initiator,
      subject: context.subject,
      details: {
        batchId,
        tenantCount: tenantIds.length,
        reason: context.reason,
        startedAt: new Date().toISOString(),
      },
    });

    const results: RotationResult[] = [];

    for (const tenantId of tenantIds) {
      const result = await this.rotateTenantKey(tenantId, {
        ...context,
        metadata: {
          ...context.metadata,
          batchId,
          batchSize: tenantIds.length,
        },
      });
      results.push(result);

      // Small delay between rotations to avoid overwhelming Vault
      if (tenantIds.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    const duration = Date.now() - startTime;
    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    appLogger.info(
      {
        event: "cmek.rotation.batch.complete",
        batchId,
        total: results.length,
        successful,
        failed,
        durationMs: duration,
      },
      `Batch CMEK rotation completed: ${successful}/${results.length} successful`,
    );

    // Audit: Batch completed
    logAuditEvent({
      action: "cmek.rotation.batch.complete",
      outcome: failed === 0 ? "success" : "failure",
      resource: "cmek/batch",
      agent: context.initiator,
      subject: context.subject,
      details: {
        batchId,
        total: results.length,
        successful,
        failed,
        durationMs: duration,
        completedAt: new Date().toISOString(),
        reason: context.reason,
        failedTenants: results
          .filter((r) => !r.success)
          .map((r) => ({ tenantId: r.tenantId, error: r.error })),
      },
    });

    return results;
  }

  /**
   * Get current key version for a tenant (helper method)
   */
  private async getCurrentKeyVersion(
    tenantId: string,
  ): Promise<string | undefined> {
    try {
      // This assumes TenantKeyManager has a method to get current version
      // If not available, this will return undefined
      const currentKey = await (this.keyManager as any).getTenantKey?.(
        tenantId,
      );
      return currentKey?.version;
    } catch {
      return undefined;
    }
  }
}

/**
 * Create audited rotation context for automated CronJob
 */
export function createCronJobContext(reason?: string): RotationAuditContext {
  return {
    initiator: "automated-cronjob",
    reason: reason || "scheduled-rotation",
    metadata: {
      automation: true,
      schedule: process.env.CMEK_ROTATION_SCHEDULE || "weekly",
    },
  };
}

/**
 * Create audited rotation context for manual operation
 */
export function createManualContext(
  userId: string,
  reason: string,
  metadata?: Record<string, unknown>,
): RotationAuditContext {
  return {
    initiator: "manual-operation",
    reason,
    subject: {
      userId,
    },
    metadata: {
      ...metadata,
      automation: false,
    },
  };
}

/**
 * Create audited rotation context for API request
 */
export function createApiContext(
  subject: AuditSubject,
  reason: string,
  requestId?: string,
): RotationAuditContext {
  return {
    initiator: "api-request",
    reason,
    subject,
    metadata: {
      requestId,
      automation: false,
    },
  };
}
