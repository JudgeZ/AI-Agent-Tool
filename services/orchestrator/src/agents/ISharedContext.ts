import type { EventEmitter } from "events";

import type {
  ContextEntry,
  ContextQueryOptions,
  ContextScope,
} from "./AgentCommunication.js";

/**
 * Interface for shared context manager implementations.
 *
 * Provides a shared key-value store for agents with:
 * - Scope-based access control (GLOBAL, PIPELINE, PRIVATE, SHARED)
 * - Owner-based permissions
 * - TTL-based expiration
 * - Version tracking
 *
 * All I/O operations are async to support both in-memory and distributed backends.
 */
export interface ISharedContext extends EventEmitter {
  /**
   * Set a context value.
   *
   * @param key - The context key
   * @param value - The value to store (must be JSON-serializable)
   * @param ownerId - The ID of the agent setting the value
   * @param scope - The visibility scope (default: PRIVATE)
   * @param ttl - Optional time-to-live in milliseconds
   */
  set(
    key: string,
    value: unknown,
    ownerId: string,
    scope?: ContextScope,
    ttl?: number,
  ): Promise<void>;

  /**
   * Get a context value.
   *
   * @param key - The context key
   * @param requesterId - The ID of the agent requesting the value
   * @returns The value, or undefined if not found/expired/access denied
   * @throws Error if access is denied
   */
  get(key: string, requesterId: string): Promise<unknown | undefined>;

  /**
   * Delete a context entry.
   * Only the owner can delete their own entries.
   *
   * @param key - The context key
   * @param requesterId - The ID of the agent requesting deletion
   * @returns true if deleted, false if not found
   * @throws Error if the requester is not the owner
   */
  delete(key: string, requesterId: string): Promise<boolean>;

  /**
   * Share a context entry with specific agents.
   * Changes the scope to SHARED and adds agents to the access list.
   *
   * @param key - The context key
   * @param ownerId - The owner's agent ID
   * @param agentIds - The agent IDs to share with
   * @throws Error if the key doesn't exist or requester is not the owner
   */
  share(key: string, ownerId: string, agentIds: string[]): Promise<void>;

  /**
   * Query context entries with filters.
   *
   * @param options - Query options (scope, ownerId, prefix, pattern)
   * @param requesterId - The ID of the agent making the query
   * @returns Matching context entries (only those accessible to the requester)
   */
  query(options: ContextQueryOptions, requesterId: string): Promise<ContextEntry[]>;

  /**
   * Get the total number of context entries.
   */
  getEntryCount(): Promise<number>;

  /**
   * Get all context keys, optionally filtered by scope.
   */
  getKeys(scope?: ContextScope): Promise<string[]>;

  /**
   * Shutdown the context manager.
   * Cleans up resources and clears all entries.
   */
  shutdown(): Promise<void>;
}
