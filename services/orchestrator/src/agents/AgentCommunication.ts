import { EventEmitter } from "events";
import { z } from "zod";

import type { IMessageBus } from "./IMessageBus.js";
import type { ISharedContext } from "./ISharedContext.js";

// ============================================================================
// Message Types and Schemas
// ============================================================================

export enum MessageType {
  REQUEST = "request",
  RESPONSE = "response",
  NOTIFICATION = "notification",
  BROADCAST = "broadcast",
  ERROR = "error",
}

export enum MessagePriority {
  LOW = 0,
  NORMAL = 1,
  HIGH = 2,
  URGENT = 3,
}

/**
 * Zod schema for message payloads
 * Supports common message patterns while remaining flexible
 */
export const MessagePayloadSchema = z.union([
  z.object({ type: z.literal("text"), content: z.string() }),
  z.object({
    type: z.literal("data"),
    data: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("error"),
    error: z.string(),
    code: z.string().optional(),
  }),
  z.object({
    type: z.literal("result"),
    result: z.unknown(),
    success: z.boolean(),
  }),
  z.record(z.string(), z.unknown()), // Fallback for unstructured payloads
]);

export type MessagePayload = z.infer<typeof MessagePayloadSchema>;

/**
 * Zod schema for message metadata
 * Allows arbitrary metadata while ensuring JSON-serializable values
 */
export const MessageMetadataSchema = z.record(
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

export type MessageMetadata = z.infer<typeof MessageMetadataSchema>;

const MessageSchema = z.object({
  id: z.string(),
  type: z.nativeEnum(MessageType),
  from: z.string(),
  to: z.union([z.string(), z.array(z.string())]).optional(), // Optional for broadcasts
  payload: MessagePayloadSchema,
  priority: z.nativeEnum(MessagePriority).default(MessagePriority.NORMAL),
  correlationId: z.string().optional(), // For request-response correlation
  timestamp: z.date(),
  ttl: z.number().optional(), // Time-to-live in milliseconds
  metadata: MessageMetadataSchema.optional(),
});

export type Message = z.infer<typeof MessageSchema>;

export interface MessageEnvelope {
  message: Message;
  deliveredAt?: Date;
  expiresAt?: Date;
  retries: number;
}

// ============================================================================
// Shared Context
// ============================================================================

export interface ContextEntry {
  key: string;
  value: unknown; // Context values are intentionally dynamic
  scope: ContextScope;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  ttl?: number; // Time-to-live in milliseconds
  metadata?: MessageMetadata;
}

export enum ContextScope {
  GLOBAL = "global", // Visible to all agents
  PIPELINE = "pipeline", // Visible within a pipeline execution
  PRIVATE = "private", // Only visible to owner
  SHARED = "shared", // Explicitly shared with specific agents
}

export interface ContextQueryOptions {
  scope?: ContextScope[];
  ownerId?: string;
  prefix?: string;
  pattern?: RegExp;
}

// ============================================================================
// Message Bus Implementation
// ============================================================================

export interface MessageBusConfig {
  maxQueueSize: number;
  defaultTtl: number; // Default message TTL
  cleanupInterval: number; // How often to clean expired messages
  maxRetries: number;
  enableMetrics: boolean;
}

const DEFAULT_MESSAGE_BUS_CONFIG: MessageBusConfig = {
  maxQueueSize: 10000,
  defaultTtl: 5 * 60 * 1000, // 5 minutes
  cleanupInterval: 60 * 1000, // 1 minute
  maxRetries: 3,
  enableMetrics: true,
};

/**
 * In-memory message bus implementation.
 *
 * Suitable for development and single-instance deployments.
 * For horizontal scaling, use RedisMessageBus instead.
 *
 * LIMITATIONS:
 * - Messages are lost on process restart
 * - Not shared across multiple instances
 * - Memory usage grows with pending messages
 */
export class MessageBus extends EventEmitter implements IMessageBus {
  private config: MessageBusConfig;
  private queues: Map<string, MessageEnvelope[]> = new Map(); // agentId -> messages
  private handlers: Map<string, Map<MessageType, MessageHandler>> = new Map(); // agentId -> type -> handler
  private pendingRequests: Map<string, PendingRequest> = new Map(); // correlationId -> request info
  private metrics: MessageBusMetrics;
  private cleanupTimer?: NodeJS.Timeout;
  private deliveryLocks: Map<string, Promise<void>> = new Map(); // agentId -> delivery promise

  constructor(config: Partial<MessageBusConfig> = {}) {
    super();
    this.config = { ...DEFAULT_MESSAGE_BUS_CONFIG, ...config };
    this.metrics = {
      messagesSent: 0,
      messagesDelivered: 0,
      messagesFailed: 0,
      messagesExpired: 0,
      averageLatency: 0,
      queueSizes: new Map(),
    };

    if (this.config.cleanupInterval > 0) {
      this.startCleanup();
    }
  }

  // ============================================================================
  // Agent Registration
  // ============================================================================

  public async registerAgent(agentId: string): Promise<void> {
    if (!this.queues.has(agentId)) {
      this.queues.set(agentId, []);
      this.handlers.set(agentId, new Map());
      this.emit("agent:registered", { agentId, timestamp: new Date() });
    }
  }

  public async unregisterAgent(agentId: string): Promise<void> {
    this.queues.delete(agentId);
    this.handlers.delete(agentId);
    this.emit("agent:unregistered", { agentId, timestamp: new Date() });
  }

  public async registerHandler(
    agentId: string,
    type: MessageType,
    handler: MessageHandler,
  ): Promise<void> {
    if (!this.handlers.has(agentId)) {
      await this.registerAgent(agentId);
    }
    this.handlers.get(agentId)!.set(type, handler);
    this.emit("handler:registered", { agentId, type });
  }

  // ============================================================================
  // Message Sending
  // ============================================================================

  public async send(
    message: Omit<Message, "id" | "timestamp">,
  ): Promise<string> {
    const fullMessage: Message = {
      ...message,
      id: this.generateMessageId(),
      timestamp: new Date(),
    };

    // Validate message
    MessageSchema.parse(fullMessage);

    this.metrics.messagesSent++;

    // Handle different message types
    if (fullMessage.type === MessageType.BROADCAST) {
      return this.broadcast(fullMessage);
    } else if (Array.isArray(fullMessage.to)) {
      return this.sendToMultiple(fullMessage, fullMessage.to);
    } else if (fullMessage.to) {
      return this.sendToOne(fullMessage, fullMessage.to);
    } else {
      throw new Error("Message must have a recipient or be a broadcast");
    }
  }

  private async sendToOne(
    message: Message,
    recipient: string,
  ): Promise<string> {
    if (!this.queues.has(recipient)) {
      this.metrics.messagesFailed++;
      throw new Error(`Agent ${recipient} not registered`);
    }

    const queue = this.queues.get(recipient)!;

    // Check queue size
    if (queue.length >= this.config.maxQueueSize) {
      this.metrics.messagesFailed++;
      throw new Error(`Queue full for agent ${recipient}`);
    }

    const envelope: MessageEnvelope = {
      message,
      retries: 0,
      expiresAt: message.ttl
        ? new Date(Date.now() + message.ttl)
        : new Date(Date.now() + this.config.defaultTtl),
    };

    // Insert based on priority
    this.insertByPriority(queue, envelope);

    this.emit("message:sent", {
      messageId: message.id,
      from: message.from,
      to: recipient,
      type: message.type,
    });

    // Schedule delivery on next tick to allow batching of concurrent sends
    setImmediate(() => this.deliverMessages(recipient));

    return message.id;
  }

  private async sendToMultiple(
    message: Message,
    recipients: string[],
  ): Promise<string> {
    const promises = recipients.map((recipient) =>
      this.sendToOne({ ...message, to: recipient }, recipient),
    );

    await Promise.all(promises);
    return message.id;
  }

  private async broadcast(message: Message): Promise<string> {
    const agents = Array.from(this.queues.keys()).filter(
      (id) => id !== message.from,
    );

    for (const agentId of agents) {
      await this.sendToOne({ ...message, to: agentId }, agentId);
    }

    this.emit("message:broadcast", {
      messageId: message.id,
      from: message.from,
      recipients: agents.length,
    });

    return message.id;
  }

  // ============================================================================
  // Message Delivery
  // ============================================================================

  private async deliverMessages(agentId: string): Promise<void> {
    // If delivery is already in progress for this agent, wait for it to complete
    // then try again in case new messages were added
    const existingLock = this.deliveryLocks.get(agentId);
    if (existingLock) {
      await existingLock;
      // After lock is released, check if there are still messages to deliver
      const queue = this.queues.get(agentId);
      if (!queue || queue.length === 0) return;
      // Recursively call to deliver any remaining messages
      return this.deliverMessages(agentId);
    }

    const queue = this.queues.get(agentId);
    if (!queue || queue.length === 0) return;

    const handlers = this.handlers.get(agentId);
    if (!handlers) return;

    // Create a lock to prevent concurrent delivery
    const deliveryPromise = this.performDelivery(agentId, queue, handlers);
    this.deliveryLocks.set(agentId, deliveryPromise);

    try {
      await deliveryPromise;
    } finally {
      this.deliveryLocks.delete(agentId);
    }
  }

  private async performDelivery(
    agentId: string,
    queue: MessageEnvelope[],
    handlers: Map<MessageType, MessageHandler>,
  ): Promise<void> {
    const now = Date.now();
    const toDeliver = queue.filter(
      (env) => !env.expiresAt || env.expiresAt.getTime() > now,
    );

    for (const envelope of toDeliver) {
      const handler = handlers.get(envelope.message.type);
      if (!handler) continue;

      try {
        envelope.deliveredAt = new Date();

        const result = await handler.handle(envelope.message);

        this.metrics.messagesDelivered++;

        // Update latency
        const latency =
          envelope.deliveredAt.getTime() - envelope.message.timestamp.getTime();
        this.updateAverageLatency(latency);

        // Remove from queue
        const index = queue.indexOf(envelope);
        if (index > -1) {
          queue.splice(index, 1);
        }

        this.emit("message:delivered", {
          messageId: envelope.message.id,
          agentId,
          latency,
        });

        // Handle response if this was a request
        if (
          envelope.message.type === MessageType.REQUEST &&
          result !== undefined
        ) {
          await this.sendResponse(envelope.message, result);
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        envelope.retries++;

        if (envelope.retries > this.config.maxRetries) {
          this.metrics.messagesFailed++;

          const index = queue.indexOf(envelope);
          if (index > -1) {
            queue.splice(index, 1);
          }

          this.emit("message:failed", {
            messageId: envelope.message.id,
            agentId,
            error: err.message,
            retries: envelope.retries,
          });

          // Send error response if this was a request
          if (envelope.message.type === MessageType.REQUEST) {
            await this.sendErrorResponse(envelope.message, err);
          }
        } else {
          this.emit("message:retry", {
            messageId: envelope.message.id,
            agentId,
            attempt: envelope.retries,
          });

          // Schedule retry delivery
          setImmediate(() => this.deliverMessages(agentId));
        }
      }
    }

    // Update metrics
    if (this.config.enableMetrics) {
      this.metrics.queueSizes.set(agentId, queue.length);
    }
  }

  // ============================================================================
  // Request-Response Pattern
  // ============================================================================

  public async request(
    from: string,
    to: string,
    payload: MessagePayload,
    timeout: number = 30000,
  ): Promise<unknown> {
    const correlationId = this.generateMessageId();

    const promise = new Promise((resolve, reject) => {
      this.pendingRequests.set(correlationId, {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.pendingRequests.delete(correlationId);
          reject(new Error(`Request timeout: ${to}`));
        }, timeout),
      });
    });

    await this.send({
      type: MessageType.REQUEST,
      from,
      to,
      payload,
      correlationId,
      priority: MessagePriority.NORMAL,
    });

    return promise;
  }

  private async sendResponse(
    requestMessage: Message,
    result: unknown,
  ): Promise<void> {
    if (!requestMessage.correlationId) return;

    await this.send({
      type: MessageType.RESPONSE,
      from: requestMessage.to as string,
      to: requestMessage.from,
      payload: { type: "result", result, success: true },
      correlationId: requestMessage.correlationId,
      priority: requestMessage.priority,
    });

    // Resolve pending request
    const pending = this.pendingRequests.get(requestMessage.correlationId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(result);
      this.pendingRequests.delete(requestMessage.correlationId);
    }
  }

  private async sendErrorResponse(
    requestMessage: Message,
    error: Error,
  ): Promise<void> {
    if (!requestMessage.correlationId) return;

    // Do not expose internal error details (stack traces) in responses
    // to prevent information disclosure
    await this.send({
      type: MessageType.ERROR,
      from: requestMessage.to as string,
      to: requestMessage.from,
      payload: { type: "error", error: error.message },
      correlationId: requestMessage.correlationId,
      priority: MessagePriority.HIGH,
    });

    // Reject pending request
    const pending = this.pendingRequests.get(requestMessage.correlationId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(requestMessage.correlationId);
    }
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredMessages();
    }, this.config.cleanupInterval);
  }

  private cleanupExpiredMessages(): void {
    const now = Date.now();
    let expiredCount = 0;

    for (const [agentId, queue] of this.queues) {
      const expired = queue.filter(
        (env) => env.expiresAt && env.expiresAt.getTime() <= now,
      );

      expiredCount += expired.length;

      // Remove expired messages
      for (const env of expired) {
        const index = queue.indexOf(env);
        if (index > -1) {
          queue.splice(index, 1);
        }

        this.emit("message:expired", {
          messageId: env.message.id,
          agentId,
        });
      }
    }

    this.metrics.messagesExpired += expiredCount;
  }

  public async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    // Reject all pending requests
    for (const [_correlationId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Message bus shutting down"));
    }
    this.pendingRequests.clear();

    this.emit("shutdown");
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  private insertByPriority(
    queue: MessageEnvelope[],
    envelope: MessageEnvelope,
  ): void {
    // Insert based on priority (higher priority first)
    let inserted = false;
    for (let i = 0; i < queue.length; i++) {
      if (envelope.message.priority > queue[i].message.priority) {
        queue.splice(i, 0, envelope);
        inserted = true;
        break;
      }
    }

    if (!inserted) {
      queue.push(envelope);
    }
  }

  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }

  private updateAverageLatency(latency: number): void {
    const total =
      this.metrics.averageLatency * (this.metrics.messagesDelivered - 1) +
      latency;
    this.metrics.averageLatency = total / this.metrics.messagesDelivered;
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  public async getMetrics(): Promise<MessageBusMetrics> {
    return { ...this.metrics };
  }

  public async getQueueSize(agentId: string): Promise<number> {
    return this.queues.get(agentId)?.length || 0;
  }

  public async getRegisteredAgents(): Promise<string[]> {
    return Array.from(this.queues.keys());
  }
}

// ============================================================================
// Shared Context Manager
// ============================================================================

export interface SharedContextConfig {
  maxEntries: number;
  defaultTtl: number;
  cleanupInterval: number;
  enableVersioning: boolean;
}

const DEFAULT_CONTEXT_CONFIG: SharedContextConfig = {
  maxEntries: 10000,
  defaultTtl: 60 * 60 * 1000, // 1 hour
  cleanupInterval: 5 * 60 * 1000, // 5 minutes
  enableVersioning: true,
};

/**
 * In-memory shared context manager implementation.
 *
 * Suitable for development and single-instance deployments.
 * For horizontal scaling, use RedisSharedContext instead.
 *
 * LIMITATIONS:
 * - Context is lost on process restart
 * - Not shared across multiple instances
 * - Memory usage grows with stored entries
 */
export class SharedContextManager extends EventEmitter implements ISharedContext {
  private config: SharedContextConfig;
  private entries: Map<string, ContextEntry> = new Map();
  private accessControl: Map<string, Set<string>> = new Map(); // key -> allowed agent IDs
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config: Partial<SharedContextConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONTEXT_CONFIG, ...config };

    if (this.config.cleanupInterval > 0) {
      this.startCleanup();
    }
  }

  // ============================================================================
  // Context Operations
  // ============================================================================

  public async set(
    key: string,
    value: unknown,
    ownerId: string,
    scope: ContextScope = ContextScope.PRIVATE,
    ttl?: number,
  ): Promise<void> {
    if (this.entries.size >= this.config.maxEntries) {
      throw new Error("Context store is full");
    }

    const existing = this.entries.get(key);
    const now = new Date();

    const entry: ContextEntry = {
      key,
      value,
      scope,
      ownerId,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      version: this.config.enableVersioning ? (existing?.version || 0) + 1 : 1,
      ttl,
    };

    this.entries.set(key, entry);

    this.emit("context:set", { key, ownerId, scope, version: entry.version });
  }

  public async get(key: string, requesterId: string): Promise<unknown | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    // Check access
    if (!this.hasAccess(entry, requesterId)) {
      throw new Error(`Access denied to context key: ${key}`);
    }

    // Check TTL
    if (this.isExpired(entry)) {
      this.entries.delete(key);
      this.accessControl.delete(key);
      this.emit("context:expired", { key, ownerId: entry.ownerId });
      return undefined;
    }

    this.emit("context:get", { key, requesterId });

    return entry.value;
  }

  public async delete(key: string, requesterId: string): Promise<boolean> {
    const entry = this.entries.get(key);
    if (!entry) return false;

    // Only owner can delete
    if (entry.ownerId !== requesterId) {
      throw new Error(`Only owner can delete context key: ${key}`);
    }

    this.entries.delete(key);
    this.accessControl.delete(key);

    this.emit("context:delete", { key, ownerId: requesterId });

    return true;
  }

  public async share(key: string, ownerId: string, agentIds: string[]): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) {
      throw new Error(`Context key not found: ${key}`);
    }

    if (entry.ownerId !== ownerId) {
      throw new Error(`Only owner can share context key: ${key}`);
    }

    if (entry.scope !== ContextScope.SHARED) {
      entry.scope = ContextScope.SHARED;
      entry.updatedAt = new Date();
    }

    if (!this.accessControl.has(key)) {
      this.accessControl.set(key, new Set());
    }

    const allowed = this.accessControl.get(key)!;
    for (const agentId of agentIds) {
      allowed.add(agentId);
    }

    this.emit("context:shared", { key, ownerId, agentIds });
  }

  public async query(
    options: ContextQueryOptions,
    requesterId: string,
  ): Promise<ContextEntry[]> {
    const results: ContextEntry[] = [];

    for (const entry of this.entries.values()) {
      // Check access
      if (!this.hasAccess(entry, requesterId)) continue;

      // Check expiration
      if (this.isExpired(entry)) continue;

      // Apply filters
      if (options.scope && !options.scope.includes(entry.scope)) continue;
      if (options.ownerId && entry.ownerId !== options.ownerId) continue;
      if (options.prefix && !entry.key.startsWith(options.prefix)) continue;
      if (options.pattern && !options.pattern.test(entry.key)) continue;

      results.push(entry);
    }

    return results;
  }

  // ============================================================================
  // Access Control
  // ============================================================================

  private hasAccess(entry: ContextEntry, requesterId: string): boolean {
    // Owner always has access
    if (entry.ownerId === requesterId) return true;

    // Check scope
    switch (entry.scope) {
      case ContextScope.GLOBAL:
        return true;

      case ContextScope.PRIVATE:
        return false;

      case ContextScope.SHARED: {
        const allowed = this.accessControl.get(entry.key);
        return allowed ? allowed.has(requesterId) : false;
      }

      case ContextScope.PIPELINE:
        // For pipeline scope, check if requester is part of the same pipeline
        // This would require additional context about pipeline membership
        return Boolean(
          entry.metadata?.pipelineId &&
            entry.metadata.pipelineId === requesterId,
        );

      default:
        return false;
    }
  }

  private isExpired(entry: ContextEntry): boolean {
    if (!entry.ttl) return false;
    const expiresAt = entry.updatedAt.getTime() + entry.ttl;
    return Date.now() > expiresAt;
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, this.config.cleanupInterval);
  }

  private cleanupExpired(): void {
    let expiredCount = 0;

    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry)) {
        this.entries.delete(key);
        this.accessControl.delete(key);
        expiredCount++;

        this.emit("context:expired", { key, ownerId: entry.ownerId });
      }
    }

    if (expiredCount > 0) {
      this.emit("cleanup:completed", { expiredEntries: expiredCount });
    }
  }

  public async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.entries.clear();
    this.accessControl.clear();

    this.emit("shutdown");
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  public async getEntryCount(): Promise<number> {
    return this.entries.size;
  }

  public async getKeys(scope?: ContextScope): Promise<string[]> {
    if (!scope) {
      return Array.from(this.entries.keys());
    }

    return Array.from(this.entries.values())
      .filter((entry) => entry.scope === scope)
      .map((entry) => entry.key);
  }
}

// ============================================================================
// Supporting Types
// ============================================================================

export interface MessageHandler {
  handle(message: Message): Promise<unknown>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface MessageBusMetrics {
  messagesSent: number;
  messagesDelivered: number;
  messagesFailed: number;
  messagesExpired: number;
  averageLatency: number;
  queueSizes: Map<string, number>;
}
