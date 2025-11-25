import type { CreateSessionInput, SessionRecord } from "./SessionStore.js";

/**
 * Interface for session storage backends.
 *
 * Implementations must be safe for concurrent access and should handle
 * TTL-based expiration appropriately for the storage backend.
 */
export interface ISessionStore {
  /**
   * Create a new session with the given input and TTL.
   *
   * @param input - Session creation parameters
   * @param ttlSeconds - Time-to-live in seconds
   * @param expiresAtMsOverride - Optional override for expiration timestamp (ms since epoch)
   * @returns The created session record
   */
  createSession(
    input: CreateSessionInput,
    ttlSeconds: number,
    expiresAtMsOverride?: number,
  ): Promise<SessionRecord>;

  /**
   * Retrieve a session by ID.
   *
   * Returns undefined if the session does not exist or has expired.
   * Implementations should automatically clean up expired sessions on access.
   *
   * @param id - The session ID
   * @returns The session record, or undefined if not found/expired
   */
  getSession(id: string): Promise<SessionRecord | undefined>;

  /**
   * Revoke (delete) a session by ID.
   *
   * @param id - The session ID to revoke
   * @returns true if the session existed and was deleted, false otherwise
   */
  revokeSession(id: string): Promise<boolean>;

  /**
   * Clear all sessions from the store.
   *
   * Use with caution - this will invalidate all active sessions.
   */
  clear(): Promise<void>;

  /**
   * Clean up expired sessions.
   *
   * For backends with automatic TTL (like Redis), this may be a no-op.
   * For in-memory backends, this should remove expired entries.
   */
  cleanupExpired(): Promise<void>;

  /**
   * Close the session store and release any resources.
   *
   * Optional - not all implementations require cleanup.
   */
  close?(): Promise<void>;
}
