import { randomUUID } from "node:crypto";
import { EventEmitter } from "events";
import { createClient } from "redis";
import { z } from "zod";

import { appLogger, normalizeError } from "../observability/logger.js";
import type { IMessageBus } from "./IMessageBus.js";
import {
  type Message,
  type MessageBusConfig,
  type MessageBusMetrics,
  type MessageHandler,
  type MessagePayload,
  MessagePayloadSchema,
  MessagePriority,
  MessageType,
} from "./AgentCommunication.js";

const logger = appLogger.child({ subsystem: "message-bus" });

type RedisClient = ReturnType<typeof createClient>;

const DEFAULT_CHANNEL_PREFIX = "msgbus";
const DEFAULT_REQUEST_TIMEOUT = 30000;

export type RedisMessageBusConfig = Partial<MessageBusConfig> & {
  redisUrl: string;
  channelPrefix?: string;
  /**
   * Unique instance ID for this orchestrator replica.
   * Used to route responses back to the correct instance.
   * If not provided, a random ID will be generated.
   */
  instanceId?: string;
};

/**
 * Zod schema for serialized messages received via Pub/Sub.
 * Validates messages at process boundary per coding guidelines.
 */
const SerializedMessageSchema = z.object({
  message: z.object({
    id: z.string(),
    type: z.nativeEnum(MessageType),
    from: z.string(),
    to: z.union([z.string(), z.array(z.string())]).optional(),
    payload: MessagePayloadSchema,
    priority: z.nativeEnum(MessagePriority).optional(),
    correlationId: z.string().optional(),
    timestamp: z.string(),
    ttl: z.number().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  sourceInstance: z.string(),
});

type SerializedMessage = z.infer<typeof SerializedMessageSchema>;

/**
 * Redis-backed message bus implementation using Pub/Sub.
 *
 * Enables inter-agent communication across multiple orchestrator instances.
 * Messages are published to Redis channels and received by the instance
 * hosting the target agent.
 *
 * Architecture:
 * - Each agent has a dedicated channel: `{prefix}:agent:{agentId}`
 * - Broadcasts use channel: `{prefix}:broadcast`
 * - Responses use channel: `{prefix}:response:{instanceId}`
 * - Handlers remain local; only message routing is distributed
 *
 * LIMITATIONS:
 * - Message handlers must be registered on the instance hosting the agent
 * - Messages are not persisted; lost if no subscriber is listening
 * - Large message payloads may impact Redis performance
 */
export class RedisMessageBus extends EventEmitter implements IMessageBus {
  private readonly config: MessageBusConfig;
  private readonly redisUrl: string;
  private readonly channelPrefix: string;
  private readonly instanceId: string;

  private publisher: RedisClient | null = null;
  private subscriber: RedisClient | null = null;
  private connecting: Promise<void> | null = null;
  private connected = false;
  private closed = false;

  // Local state (per-instance)
  private readonly localAgents = new Set<string>();
  private readonly handlers = new Map<string, Map<MessageType, MessageHandler>>();
  private readonly pendingRequests = new Map<string, PendingRequest>();

  private metrics: MessageBusMetrics;

  constructor(config: RedisMessageBusConfig) {
    super();
    this.redisUrl = config.redisUrl;
    this.channelPrefix = config.channelPrefix ?? DEFAULT_CHANNEL_PREFIX;
    this.instanceId = config.instanceId ?? `instance-${randomUUID()}`;

    this.config = {
      maxQueueSize: config.maxQueueSize ?? 10000,
      defaultTtl: config.defaultTtl ?? 5 * 60 * 1000,
      cleanupInterval: config.cleanupInterval ?? 60 * 1000,
      maxRetries: config.maxRetries ?? 3,
      enableMetrics: config.enableMetrics ?? true,
    };

    this.metrics = {
      messagesSent: 0,
      messagesDelivered: 0,
      messagesFailed: 0,
      messagesExpired: 0,
      averageLatency: 0,
      queueSizes: new Map(),
    };
  }

  private formatAgentChannel(agentId: string): string {
    return `${this.channelPrefix}:agent:${agentId}`;
  }

  private formatBroadcastChannel(): string {
    return `${this.channelPrefix}:broadcast`;
  }

  private formatResponseChannel(): string {
    return `${this.channelPrefix}:response:${this.instanceId}`;
  }

  private formatGlobalRegistryKey(): string {
    return `${this.channelPrefix}:agents:global`;
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) {
      throw new Error("Message bus is closed");
    }
    if (this.connected) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = this.connect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connect(): Promise<void> {
    // Create publisher client
    const publisher = createClient({ url: this.redisUrl });
    publisher.on("error", (error) => {
      logger.warn({ err: normalizeError(error), event: "msgbus.redis.publisher.error" }, "Redis publisher error");
    });

    // Create subscriber client (Redis requires separate client for subscriptions)
    const subscriber = createClient({ url: this.redisUrl });
    subscriber.on("error", (error) => {
      logger.warn({ err: normalizeError(error), event: "msgbus.redis.subscriber.error" }, "Redis subscriber error");
    });

    await Promise.all([publisher.connect(), subscriber.connect()]);

    this.publisher = publisher;
    this.subscriber = subscriber;

    // Subscribe to response channel for this instance
    await subscriber.subscribe(this.formatResponseChannel(), (message) => {
      this.handleIncomingMessage(message);
    });

    // Subscribe to broadcast channel
    await subscriber.subscribe(this.formatBroadcastChannel(), (message) => {
      this.handleIncomingMessage(message);
    });

    this.connected = true;
    logger.info(
      { instanceId: this.instanceId, event: "msgbus.redis.connected" },
      "Redis message bus connected",
    );
  }

  private handleIncomingMessage(rawMessage: string): void {
    // Validate message at process boundary using Zod schema
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMessage);
    } catch (error) {
      logger.warn(
        { err: normalizeError(error), event: "msgbus.redis.message.json_parse_failed" },
        "Failed to parse incoming message JSON",
      );
      return;
    }

    const parseResult = SerializedMessageSchema.safeParse(parsed);
    if (!parseResult.success) {
      logger.warn(
        { error: parseResult.error.message, event: "msgbus.redis.message.validation_failed" },
        "Incoming message failed schema validation",
      );
      return;
    }

    const { message: serialized, sourceInstance } = parseResult.data;

    // Reconstruct message with Date object
    const message: Message = {
      ...serialized,
      priority: serialized.priority ?? MessagePriority.NORMAL,
      timestamp: new Date(serialized.timestamp),
    };

    // Handle response messages (for request-response pattern)
    if (message.type === MessageType.RESPONSE || message.type === MessageType.ERROR) {
      if (message.correlationId) {
        const pending = this.pendingRequests.get(message.correlationId);
        if (pending) {
          clearTimeout(pending.timeout);
          if (message.type === MessageType.ERROR) {
            const payload = message.payload as { error?: string };
            pending.reject(new Error(payload.error ?? "Request failed"));
          } else {
            const payload = message.payload as { result?: unknown };
            pending.resolve(payload.result);
          }
          this.pendingRequests.delete(message.correlationId);
        }
      }
      return;
    }

    // Handle messages for local agents
    const targetAgentId = typeof message.to === "string" ? message.to : undefined;
    if (targetAgentId && this.localAgents.has(targetAgentId)) {
      this.deliverToLocalAgent(targetAgentId, message, sourceInstance).catch((error) => {
        logger.warn(
          { err: normalizeError(error), agentId: targetAgentId, messageId: message.id, event: "msgbus.delivery.failed" },
          "Failed to deliver message to local agent",
        );
        this.emit("error", { error, agentId: targetAgentId, messageId: message.id, event: "delivery.failed" });
      });
    } else if (message.type === MessageType.BROADCAST) {
      // Deliver broadcast to all local agents except sender
      for (const agentId of this.localAgents) {
        if (agentId !== message.from) {
          this.deliverToLocalAgent(agentId, message, sourceInstance).catch((error) => {
            logger.warn(
              { err: normalizeError(error), agentId, messageId: message.id, event: "msgbus.broadcast.delivery.failed" },
              "Failed to deliver broadcast message to local agent",
            );
            this.emit("error", { error, agentId, messageId: message.id, event: "broadcast.delivery.failed" });
          });
        }
      }
    }
  }

  private async deliverToLocalAgent(agentId: string, message: Message, sourceInstance: string): Promise<void> {
    const handlers = this.handlers.get(agentId);
    const handler = handlers?.get(message.type);

    if (!handler) {
      logger.debug(
        { agentId, messageType: message.type, event: "msgbus.no_handler" },
        "No handler registered for message type",
      );
      return;
    }

    try {
      const result = await handler.handle(message);
      this.metrics.messagesDelivered++;

      this.emit("message:delivered", {
        messageId: message.id,
        agentId,
        latency: Date.now() - message.timestamp.getTime(),
      });

      // Send response if this was a request
      if (message.type === MessageType.REQUEST && message.correlationId && result !== undefined) {
        await this.sendResponse(message, result, sourceInstance);
      }
    } catch (error) {
      this.metrics.messagesFailed++;
      logger.warn(
        { err: normalizeError(error), agentId, messageId: message.id, event: "msgbus.handler.failed" },
        "Message handler failed",
      );

      // Send error response if this was a request
      if (message.type === MessageType.REQUEST && message.correlationId) {
        const err = error instanceof Error ? error : new Error(String(error));
        await this.sendErrorResponse(message, err, sourceInstance);
      }
    }
  }

  private async sendResponse(request: Message, result: unknown, targetInstance: string): Promise<void> {
    if (!this.publisher) return;

    const response: Message = {
      id: this.generateMessageId(),
      type: MessageType.RESPONSE,
      from: request.to as string,
      to: request.from,
      payload: { type: "result", result, success: true },
      correlationId: request.correlationId,
      priority: request.priority,
      timestamp: new Date(),
    };

    const serialized: SerializedMessage = {
      message: { ...response, timestamp: response.timestamp.toISOString() },
      sourceInstance: this.instanceId,
    };

    // Send to the specific instance that made the request
    const responseChannel = `${this.channelPrefix}:response:${targetInstance}`;
    await this.publisher.publish(responseChannel, JSON.stringify(serialized));
  }

  private async sendErrorResponse(request: Message, error: Error, targetInstance: string): Promise<void> {
    if (!this.publisher) return;

    // Sanitize error message to prevent internal info leakage
    // Only expose known safe error messages; replace others with generic message
    const safeErrorPatterns = [
      /^Request timeout:/,
      /^No handler registered/,
      /^Agent not found/,
      /^Message bus shutting down$/,
    ];
    const isSafeMessage = safeErrorPatterns.some((pattern) => pattern.test(error.message));
    const sanitizedError = isSafeMessage ? error.message : "Request processing failed";

    const response: Message = {
      id: this.generateMessageId(),
      type: MessageType.ERROR,
      from: request.to as string,
      to: request.from,
      payload: { type: "error", error: sanitizedError },
      correlationId: request.correlationId,
      priority: MessagePriority.HIGH,
      timestamp: new Date(),
    };

    const serialized: SerializedMessage = {
      message: { ...response, timestamp: response.timestamp.toISOString() },
      sourceInstance: this.instanceId,
    };

    const responseChannel = `${this.channelPrefix}:response:${targetInstance}`;
    await this.publisher.publish(responseChannel, JSON.stringify(serialized));
  }

  // ============================================================================
  // IMessageBus Implementation
  // ============================================================================

  async registerAgent(agentId: string): Promise<void> {
    if (this.localAgents.has(agentId)) {
      return;
    }

    this.localAgents.add(agentId);
    this.handlers.set(agentId, new Map());

    // Subscribe to agent's channel and register in global registry
    try {
      await this.ensureConnected();
      if (this.subscriber && !this.closed) {
        await this.subscriber.subscribe(this.formatAgentChannel(agentId), (message) => {
          this.handleIncomingMessage(message);
        });
        logger.debug({ agentId, event: "msgbus.agent.subscribed" }, "Subscribed to agent channel");
      }
      // Add to global agent registry
      if (this.publisher && !this.closed) {
        await this.publisher.sAdd(this.formatGlobalRegistryKey(), agentId);
        logger.debug({ agentId, event: "msgbus.agent.global_registered" }, "Added agent to global registry");
      }
    } catch (error) {
      logger.warn(
        { err: normalizeError(error), agentId, event: "msgbus.agent.subscribe_failed" },
        "Failed to subscribe to agent channel or register globally",
      );
    }

    this.emit("agent:registered", { agentId, timestamp: new Date() });
  }

  async unregisterAgent(agentId: string): Promise<void> {
    if (!this.localAgents.has(agentId)) {
      return;
    }

    this.localAgents.delete(agentId);
    this.handlers.delete(agentId);

    // Unsubscribe from agent's channel and remove from global registry
    if (this.subscriber && !this.closed) {
      try {
        await this.subscriber.unsubscribe(this.formatAgentChannel(agentId));
      } catch (error) {
        logger.warn(
          { err: normalizeError(error), agentId, event: "msgbus.agent.unsubscribe_failed" },
          "Failed to unsubscribe from agent channel",
        );
      }
    }

    // Remove from global agent registry
    if (this.publisher && !this.closed) {
      try {
        await this.publisher.sRem(this.formatGlobalRegistryKey(), agentId);
        logger.debug({ agentId, event: "msgbus.agent.global_unregistered" }, "Removed agent from global registry");
      } catch (error) {
        logger.warn(
          { err: normalizeError(error), agentId, event: "msgbus.agent.global_unregister_failed" },
          "Failed to remove agent from global registry",
        );
      }
    }

    this.emit("agent:unregistered", { agentId, timestamp: new Date() });
  }

  async registerHandler(agentId: string, type: MessageType, handler: MessageHandler): Promise<void> {
    if (!this.handlers.has(agentId)) {
      await this.registerAgent(agentId);
    }
    this.handlers.get(agentId)!.set(type, handler);
    this.emit("handler:registered", { agentId, type });
  }

  async send(message: Omit<Message, "id" | "timestamp">): Promise<string> {
    await this.ensureConnected();

    const fullMessage: Message = {
      ...message,
      id: this.generateMessageId(),
      timestamp: new Date(),
    };

    this.metrics.messagesSent++;

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

  private async sendToOne(message: Message, recipient: string): Promise<string> {
    if (!this.publisher) {
      throw new Error("Publisher not connected");
    }

    const serialized: SerializedMessage = {
      message: { ...message, timestamp: message.timestamp.toISOString() },
      sourceInstance: this.instanceId,
    };

    // If recipient is local, deliver directly
    if (this.localAgents.has(recipient)) {
      this.deliverToLocalAgent(recipient, message, this.instanceId).catch((error) => {
        logger.warn(
          { err: normalizeError(error), agentId: recipient, messageId: message.id, event: "msgbus.sendtoone.delivery.failed" },
          "Failed to deliver message to local agent in sendToOne",
        );
        this.emit("error", { error, agentId: recipient, messageId: message.id, event: "sendtoone.delivery.failed" });
      });
    } else {
      // Publish to recipient's channel
      await this.publisher.publish(
        this.formatAgentChannel(recipient),
        JSON.stringify(serialized),
      );
    }

    this.emit("message:sent", {
      messageId: message.id,
      from: message.from,
      to: recipient,
      type: message.type,
    });

    return message.id;
  }

  private async sendToMultiple(message: Message, recipients: string[]): Promise<string> {
    await Promise.all(
      recipients.map((recipient) => this.sendToOne({ ...message, to: recipient }, recipient)),
    );
    return message.id;
  }

  private async broadcast(message: Message): Promise<string> {
    if (!this.publisher) {
      throw new Error("Publisher not connected");
    }

    const serialized: SerializedMessage = {
      message: { ...message, timestamp: message.timestamp.toISOString() },
      sourceInstance: this.instanceId,
    };

    await this.publisher.publish(this.formatBroadcastChannel(), JSON.stringify(serialized));

    this.emit("message:broadcast", {
      messageId: message.id,
      from: message.from,
    });

    return message.id;
  }

  async request(
    from: string,
    to: string,
    payload: MessagePayload,
    timeout: number = DEFAULT_REQUEST_TIMEOUT,
  ): Promise<unknown> {
    const correlationId = this.generateMessageId();

    const promise = new Promise<unknown>((resolve, reject) => {
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

  async getMetrics(): Promise<MessageBusMetrics> {
    return { ...this.metrics };
  }

  async getQueueSize(_agentId: string): Promise<number> {
    // Redis pub/sub doesn't maintain queues; messages are delivered immediately
    // or lost if no subscriber is listening
    return 0;
  }

  async getRegisteredAgents(): Promise<string[]> {
    // Return all agents from the global registry (across all instances)
    if (this.publisher && !this.closed) {
      try {
        const globalAgents = await this.publisher.sMembers(this.formatGlobalRegistryKey());
        return globalAgents;
      } catch (error) {
        logger.warn(
          { err: normalizeError(error), event: "msgbus.agent.global_list_failed" },
          "Failed to get global agent list, falling back to local agents",
        );
      }
    }
    // Fallback to local agents if Redis is unavailable
    return Array.from(this.localAgents);
  }

  async shutdown(): Promise<void> {
    this.closed = true;

    // Reject all pending requests
    for (const [_correlationId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Message bus shutting down"));
    }
    this.pendingRequests.clear();

    // Remove local agents from global registry before closing
    const localAgentsCopy = Array.from(this.localAgents);
    const subscriber = this.subscriber;
    const publisher = this.publisher;

    if (publisher && localAgentsCopy.length > 0) {
      try {
        await publisher.sRem(this.formatGlobalRegistryKey(), localAgentsCopy);
        logger.debug(
          { agentCount: localAgentsCopy.length, event: "msgbus.shutdown.global_cleanup" },
          "Removed local agents from global registry during shutdown",
        );
      } catch (error) {
        logger.warn(
          { err: normalizeError(error), event: "msgbus.shutdown.global_cleanup_failed" },
          "Failed to remove local agents from global registry during shutdown",
        );
      }
    }

    // Close Redis connections
    this.subscriber = null;
    this.publisher = null;

    if (subscriber) {
      try {
        await subscriber.quit();
      } catch (error) {
        logger.warn(
          { err: normalizeError(error), event: "msgbus.redis.subscriber.close_failed" },
          "Failed to close Redis subscriber",
        );
      }
    }

    if (publisher) {
      try {
        await publisher.quit();
      } catch (error) {
        logger.warn(
          { err: normalizeError(error), event: "msgbus.redis.publisher.close_failed" },
          "Failed to close Redis publisher",
        );
      }
    }

    logger.info({ event: "msgbus.redis.closed" }, "Redis message bus closed");
    this.emit("shutdown");
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  private generateMessageId(): string {
    // Use randomUUID for better collision resistance in distributed scenarios
    return `msg_${this.instanceId}_${randomUUID()}`;
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}
