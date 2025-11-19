import { Logger } from "pino";
import { EventEmitter } from "events";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

/**
 * Zod schema for approval details and metadata
 * Ensures JSON-serializable values
 */
export const ApprovalDataSchema = z.record(
  z.string(),
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.unknown()),
    z.record(z.string(), z.unknown()),
    z.null(),
  ]),
);

export type ApprovalData = z.infer<typeof ApprovalDataSchema>;

/**
 * Approval request status
 */
export enum ApprovalStatus {
  PENDING = "pending",
  APPROVED = "approved",
  DENIED = "denied",
  EXPIRED = "expired",
  CANCELLED = "cancelled",
}

/**
 * Approval request
 */
export interface ApprovalRequest {
  /** Unique request ID */
  id: string;

  /** Tool or operation requiring approval */
  operation: string;

  /** Reason for approval request */
  reason: string;

  /** Additional details */
  details: ApprovalData;

  /** Requesting user/tenant */
  requesterId?: string;

  /** Tenant ID */
  tenantId?: string;

  /** Current status */
  status: ApprovalStatus;

  /** When request was created */
  createdAt: Date;

  /** When request expires */
  expiresAt?: Date;

  /** When request was resolved */
  resolvedAt?: Date;

  /** Who approved/denied */
  resolvedBy?: string;

  /** Resolution comment */
  resolutionComment?: string;

  /** Request metadata */
  metadata?: ApprovalData;
}

/**
 * Batch approval request
 */
export interface BatchApprovalRequest {
  /** Batch ID */
  batchId: string;

  /** Individual requests in the batch */
  requests: ApprovalRequest[];

  /** Batch description */
  description: string;

  /** Created timestamp */
  createdAt: Date;
}

/**
 * Approval configuration
 */
export interface ApprovalConfig {
  /** Default timeout for approvals (ms) */
  defaultTimeout?: number;

  /** Maximum pending requests per tenant */
  maxPendingPerTenant?: number;

  /** Auto-deny on timeout */
  autoDenyOnTimeout?: boolean;

  /** Enable batch approvals */
  enableBatchApprovals?: boolean;

  /** Audit all approval decisions */
  auditEnabled?: boolean;
}

/**
 * Approval manager for handling user approval workflows
 *
 * Features:
 * - Request approval for dangerous operations
 * - Timeout handling with auto-deny
 * - Batch approvals for efficiency
 * - Approval history and audit trail
 * - Event-driven notifications
 */
export class ApprovalManager extends EventEmitter {
  private requests: Map<string, ApprovalRequest>;
  private batches: Map<string, BatchApprovalRequest>;
  private logger: Logger;
  private config: ApprovalConfig;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(logger: Logger, config?: ApprovalConfig) {
    super();
    this.requests = new Map();
    this.batches = new Map();
    this.logger = logger.child({ component: "ApprovalManager" });
    this.config = {
      defaultTimeout: 300000, // 5 minutes
      maxPendingPerTenant: 100,
      autoDenyOnTimeout: true,
      enableBatchApprovals: true,
      auditEnabled: true,
      ...config,
    };

    // Start cleanup interval for expired requests
    this.startCleanupInterval();
  }

  /**
   * Request approval for an operation
   */
  async requestApproval(
    operation: string,
    reason: string,
    details: ApprovalData,
    options?: {
      requesterId?: string;
      tenantId?: string;
      timeout?: number;
      metadata?: ApprovalData;
    },
  ): Promise<boolean> {
    const requestId = uuidv4();
    const timeout = options?.timeout ?? this.config.defaultTimeout!;

    // Check tenant limits
    if (options?.tenantId && !this.checkTenantLimit(options.tenantId)) {
      this.logger.warn(
        { tenantId: options.tenantId },
        "Tenant has too many pending approval requests",
      );
      throw new Error("Too many pending approval requests");
    }

    const request: ApprovalRequest = {
      id: requestId,
      operation,
      reason,
      details,
      requesterId: options?.requesterId,
      tenantId: options?.tenantId,
      status: ApprovalStatus.PENDING,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + timeout),
      metadata: options?.metadata,
    };

    this.requests.set(requestId, request);

    this.logger.info(
      { requestId, operation, tenantId: options?.tenantId },
      "Approval requested",
    );

    this.emit("requested", { request });

    // Wait for approval or timeout
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        const req = this.requests.get(requestId);

        if (req && req.status === ApprovalStatus.PENDING) {
          if (this.config.autoDenyOnTimeout) {
            req.status = ApprovalStatus.EXPIRED;
            req.resolvedAt = new Date();
            req.resolutionComment = "Approval request timed out";

            this.logger.warn({ requestId }, "Approval request expired");
            this.emit("expired", { request: req });

            resolve(false);
          } else {
            reject(new Error("Approval request timed out"));
          }
        }
      }, timeout);

      // Listen for approval/denial/cancellation/expiration
      const cleanup = () => {
        clearTimeout(timeoutHandle);
        this.off("approved", approvalListener);
        this.off("denied", denialListener);
        this.off("cancelled", cancellationListener);
        this.off("expired", expiredListener);
      };

      const approvalListener = ({
        request: approvedReq,
      }: {
        request: ApprovalRequest;
      }) => {
        if (approvedReq.id === requestId) {
          cleanup();
          resolve(true);
        }
      };

      const denialListener = ({
        request: deniedReq,
      }: {
        request: ApprovalRequest;
      }) => {
        if (deniedReq.id === requestId) {
          cleanup();
          resolve(false);
        }
      };

      const cancellationListener = ({
        request: cancelledReq,
      }: {
        request: ApprovalRequest;
      }) => {
        if (cancelledReq.id === requestId) {
          cleanup();
          resolve(false);
        }
      };

      const expiredListener = ({
        request: expiredReq,
      }: {
        request: ApprovalRequest;
      }) => {
        if (expiredReq.id === requestId) {
          cleanup();
          resolve(false);
        }
      };

      this.on("approved", approvalListener);
      this.on("denied", denialListener);
      this.on("cancelled", cancellationListener);
      this.on("expired", expiredListener);
    });
  }

  /**
   * Approve a pending request
   */
  approve(requestId: string, approvedBy?: string, comment?: string): boolean {
    const request = this.requests.get(requestId);

    if (!request) {
      this.logger.warn({ requestId }, "Approval request not found");
      return false;
    }

    if (request.status !== ApprovalStatus.PENDING) {
      this.logger.warn(
        { requestId, status: request.status },
        "Request already resolved",
      );
      return false;
    }

    request.status = ApprovalStatus.APPROVED;
    request.resolvedAt = new Date();
    request.resolvedBy = approvedBy;
    request.resolutionComment = comment;

    this.logger.info(
      { requestId, approvedBy, operation: request.operation },
      "Request approved",
    );

    this.emit("approved", { request });

    if (this.config.auditEnabled) {
      this.auditDecision(request);
    }

    return true;
  }

  /**
   * Deny a pending request
   */
  deny(requestId: string, deniedBy?: string, comment?: string): boolean {
    const request = this.requests.get(requestId);

    if (!request) {
      this.logger.warn({ requestId }, "Approval request not found");
      return false;
    }

    if (request.status !== ApprovalStatus.PENDING) {
      this.logger.warn(
        { requestId, status: request.status },
        "Request already resolved",
      );
      return false;
    }

    request.status = ApprovalStatus.DENIED;
    request.resolvedAt = new Date();
    request.resolvedBy = deniedBy;
    request.resolutionComment = comment;

    this.logger.info(
      { requestId, deniedBy, operation: request.operation },
      "Request denied",
    );

    this.emit("denied", { request });

    if (this.config.auditEnabled) {
      this.auditDecision(request);
    }

    return true;
  }

  /**
   * Cancel a pending request
   */
  cancel(requestId: string): boolean {
    const request = this.requests.get(requestId);

    if (!request) {
      return false;
    }

    if (request.status !== ApprovalStatus.PENDING) {
      return false;
    }

    request.status = ApprovalStatus.CANCELLED;
    request.resolvedAt = new Date();

    this.logger.info({ requestId }, "Request cancelled");
    this.emit("cancelled", { request });

    return true;
  }

  /**
   * Create a batch approval request
   */
  createBatch(
    requests: Array<{
      operation: string;
      reason: string;
      details: ApprovalData;
    }>,
    description: string,
    options?: {
      requesterId?: string;
      tenantId?: string;
    },
  ): string {
    if (!this.config.enableBatchApprovals) {
      throw new Error("Batch approvals are disabled");
    }

    const batchId = uuidv4();

    const approvalRequests = requests.map((req) => ({
      id: uuidv4(),
      operation: req.operation,
      reason: req.reason,
      details: req.details,
      requesterId: options?.requesterId,
      tenantId: options?.tenantId,
      status: ApprovalStatus.PENDING,
      createdAt: new Date(),
    }));

    const batch: BatchApprovalRequest = {
      batchId,
      requests: approvalRequests,
      description,
      createdAt: new Date(),
    };

    // Add individual requests to the main map
    approvalRequests.forEach((req) => {
      this.requests.set(req.id, req);
    });

    this.batches.set(batchId, batch);

    this.logger.info(
      { batchId, count: requests.length },
      "Batch approval created",
    );

    this.emit("batchCreated", { batch });

    return batchId;
  }

  /**
   * Approve all requests in a batch
   */
  approveBatch(batchId: string, approvedBy?: string, comment?: string): number {
    const batch = this.batches.get(batchId);

    if (!batch) {
      this.logger.warn({ batchId }, "Batch not found");
      return 0;
    }

    let approved = 0;

    for (const request of batch.requests) {
      if (this.approve(request.id, approvedBy, comment)) {
        approved++;
      }
    }

    this.logger.info({ batchId, approved }, "Batch approved");
    this.emit("batchApproved", { batchId, approved });

    return approved;
  }

  /**
   * Deny all requests in a batch
   */
  denyBatch(batchId: string, deniedBy?: string, comment?: string): number {
    const batch = this.batches.get(batchId);

    if (!batch) {
      this.logger.warn({ batchId }, "Batch not found");
      return 0;
    }

    let denied = 0;

    for (const request of batch.requests) {
      if (this.deny(request.id, deniedBy, comment)) {
        denied++;
      }
    }

    this.logger.info({ batchId, denied }, "Batch denied");
    this.emit("batchDenied", { batchId, denied });

    return denied;
  }

  /**
   * Get pending requests for a tenant
   */
  getPendingRequests(tenantId?: string): ApprovalRequest[] {
    const pending: ApprovalRequest[] = [];

    for (const request of this.requests.values()) {
      if (request.status === ApprovalStatus.PENDING) {
        if (!tenantId || request.tenantId === tenantId) {
          pending.push(request);
        }
      }
    }

    return pending;
  }

  /**
   * Get a specific request
   */
  getRequest(requestId: string): ApprovalRequest | undefined {
    return this.requests.get(requestId);
  }

  /**
   * Get a batch
   */
  getBatch(batchId: string): BatchApprovalRequest | undefined {
    return this.batches.get(batchId);
  }

  /**
   * Get approval statistics
   */
  getStats(tenantId?: string): {
    pending: number;
    approved: number;
    denied: number;
    expired: number;
    cancelled: number;
  } {
    const stats = {
      pending: 0,
      approved: 0,
      denied: 0,
      expired: 0,
      cancelled: 0,
    };

    for (const request of this.requests.values()) {
      if (!tenantId || request.tenantId === tenantId) {
        switch (request.status) {
          case ApprovalStatus.PENDING:
            stats.pending++;
            break;
          case ApprovalStatus.APPROVED:
            stats.approved++;
            break;
          case ApprovalStatus.DENIED:
            stats.denied++;
            break;
          case ApprovalStatus.EXPIRED:
            stats.expired++;
            break;
          case ApprovalStatus.CANCELLED:
            stats.cancelled++;
            break;
        }
      }
    }

    return stats;
  }

  /**
   * Check if tenant is within request limits
   */
  private checkTenantLimit(tenantId: string): boolean {
    const pending = this.getPendingRequests(tenantId);
    return pending.length < (this.config.maxPendingPerTenant || 100);
  }

  /**
   * Audit an approval decision
   */
  private auditDecision(request: ApprovalRequest): void {
    // In production, this would write to an audit log service
    this.logger.info(
      {
        requestId: request.id,
        operation: request.operation,
        status: request.status,
        resolvedBy: request.resolvedBy,
        tenantId: request.tenantId,
        duration: request.resolvedAt
          ? request.resolvedAt.getTime() - request.createdAt.getTime()
          : 0,
      },
      "Approval decision audited",
    );
  }

  /**
   * Start cleanup interval for expired requests
   */
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, 60000); // Run every minute
  }

  /**
   * Clean up expired requests
   */
  private cleanupExpired(): void {
    const now = new Date();
    let cleaned = 0;

    for (const [id, request] of this.requests.entries()) {
      if (
        request.status === ApprovalStatus.PENDING &&
        request.expiresAt &&
        request.expiresAt < now
      ) {
        if (this.config.autoDenyOnTimeout) {
          request.status = ApprovalStatus.EXPIRED;
          request.resolvedAt = now;
          this.emit("expired", { request });
        }
        cleaned++;
      }

      // Remove old resolved requests (older than 1 hour)
      if (
        request.resolvedAt &&
        now.getTime() - request.resolvedAt.getTime() > 3600000
      ) {
        this.requests.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug({ cleaned }, "Cleaned up expired requests");
    }
  }

  /**
   * Stop the manager and cleanup
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.requests.clear();
    this.batches.clear();

    this.logger.info("Approval manager shut down");
  }
}
