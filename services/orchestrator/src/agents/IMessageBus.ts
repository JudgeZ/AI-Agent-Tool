import type { EventEmitter } from "events";

import type {
  Message,
  MessageBusMetrics,
  MessageHandler,
  MessagePayload,
  MessageType,
} from "./AgentCommunication.js";

/**
 * Interface for message bus implementations.
 *
 * Provides inter-agent communication with support for:
 * - Point-to-point messaging
 * - Broadcast messaging
 * - Request-response patterns
 * - Priority-based message delivery
 */
export interface IMessageBus extends EventEmitter {
  /**
   * Register an agent with the message bus.
   * Creates a message queue for the agent.
   */
  registerAgent(agentId: string): void;

  /**
   * Unregister an agent from the message bus.
   * Removes the agent's message queue.
   */
  unregisterAgent(agentId: string): void;

  /**
   * Register a message handler for an agent.
   *
   * @param agentId - The agent ID to register the handler for
   * @param type - The message type to handle
   * @param handler - The handler implementation
   */
  registerHandler(agentId: string, type: MessageType, handler: MessageHandler): void;

  /**
   * Send a message.
   *
   * @param message - The message to send (id and timestamp will be auto-generated)
   * @returns The generated message ID
   */
  send(message: Omit<Message, "id" | "timestamp">): Promise<string>;

  /**
   * Send a request and wait for a response.
   *
   * @param from - The sender agent ID
   * @param to - The recipient agent ID
   * @param payload - The request payload
   * @param timeout - Request timeout in milliseconds (default: 30000)
   * @returns The response from the recipient
   */
  request(
    from: string,
    to: string,
    payload: MessagePayload,
    timeout?: number,
  ): Promise<unknown>;

  /**
   * Get current metrics.
   */
  getMetrics(): MessageBusMetrics;

  /**
   * Get the queue size for an agent.
   */
  getQueueSize(agentId: string): number;

  /**
   * Get all registered agent IDs.
   */
  getRegisteredAgents(): string[];

  /**
   * Shutdown the message bus.
   * Cleans up resources and rejects pending requests.
   */
  shutdown(): void;
}
