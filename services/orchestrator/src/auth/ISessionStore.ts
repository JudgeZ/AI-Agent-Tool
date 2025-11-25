/**
 * Session record stored in the session store.
 */
export type SessionRecord = {
  id: string;
  subject: string;
  email?: string;
  name?: string;
  tenantId?: string;
  roles: string[];
  scopes: string[];
  issuedAt: string;
  expiresAt: string;
  claims: Record<string, unknown>;
};

/**
 * Input for creating a new session.
 */
export type CreateSessionInput = {
  subject: string;
  email?: string;
  name?: string;
  tenantId?: string;
  roles: string[];
  scopes: string[];
  claims: Record<string, unknown>;
};

/**
 * Interface for session storage backends.
 * Implementations must be thread-safe and support concurrent access.
 */
export interface ISessionStore {
  /**
   * Creates a new session with the given input and TTL.
   * @param input - Session creation parameters
   * @param ttlSeconds - Time-to-live in seconds
   * @param expiresAtMsOverride - Optional override for expiration timestamp (capped by TTL)
   * @returns The created session record
   */
  createSession(
    input: CreateSessionInput,
    ttlSeconds: number,
    expiresAtMsOverride?: number,
  ): Promise<SessionRecord>;

  /**
   * Retrieves a session by ID.
   * @param id - Session ID
   * @returns The session record if found and not expired, undefined otherwise
   */
  getSession(id: string): Promise<SessionRecord | undefined>;

  /**
   * Revokes (deletes) a session by ID.
   * @param id - Session ID
   * @returns true if the session was found and deleted, false otherwise
   */
  revokeSession(id: string): Promise<boolean>;

  /**
   * Clears all sessions from the store.
   */
  clear(): Promise<void>;

  /**
   * Cleans up expired sessions.
   * For backends with automatic TTL (like Redis), this may be a no-op.
   */
  cleanupExpired(): Promise<void>;

  /**
   * Disconnects from the backing store (if applicable).
   */
  disconnect?(): Promise<void>;
}
