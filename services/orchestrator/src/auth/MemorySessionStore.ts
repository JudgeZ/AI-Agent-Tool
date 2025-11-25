import type { CreateSessionInput, ISessionStore, SessionRecord } from "./ISessionStore.js";
import { buildSessionRecord, isSessionExpired } from "./sessionUtils.js";

/**
 * In-memory implementation of ISessionStore.
 * Suitable for single-instance deployments or development.
 * Does not persist sessions across restarts.
 */
export class MemorySessionStore implements ISessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  async createSession(
    input: CreateSessionInput,
    ttlSeconds: number,
    expiresAtMsOverride?: number,
  ): Promise<SessionRecord> {
    const session = buildSessionRecord(input, ttlSeconds, expiresAtMsOverride);
    this.sessions.set(session.id, session);
    return session;
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const session = this.sessions.get(id);
    if (!session) {
      return undefined;
    }
    if (isSessionExpired(session)) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  async revokeSession(id: string): Promise<boolean> {
    return this.sessions.delete(id);
  }

  async clear(): Promise<void> {
    this.sessions.clear();
  }

  async cleanupExpired(): Promise<void> {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now >= Date.parse(session.expiresAt)) {
        this.sessions.delete(id);
      }
    }
  }

  /**
   * Returns the number of sessions currently stored.
   * Useful for testing and monitoring.
   */
  get size(): number {
    return this.sessions.size;
  }
}
