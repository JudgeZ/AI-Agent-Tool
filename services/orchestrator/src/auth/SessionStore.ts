import { loadConfig, type SessionStoreConfig } from "../config/loadConfig.js";
import { appLogger } from "../observability/logger.js";
import type { CreateSessionInput, ISessionStore, SessionRecord } from "./ISessionStore.js";
import { MemorySessionStore } from "./MemorySessionStore.js";
import { RedisSessionStore } from "./RedisSessionStore.js";
import { buildSessionRecord, isSessionExpired } from "./sessionUtils.js";

// Re-export types for backwards compatibility
export type { CreateSessionInput, ISessionStore, SessionRecord } from "./ISessionStore.js";

let sessionStorePromise: Promise<ISessionStore> | null = null;

/**
 * Creates a session store based on configuration.
 * @param config - Session store configuration
 * @returns A promise that resolves to the configured session store
 */
export async function createSessionStore(config: SessionStoreConfig): Promise<ISessionStore> {
  if (config.provider === "redis") {
    const redisUrl = config.redisUrl ?? process.env.SESSION_REDIS_URL ?? process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error("Redis session store requires a Redis URL to be configured");
    }
    const store = new RedisSessionStore(redisUrl);
    await store.connect();
    appLogger.info({ provider: "redis", subsystem: "session-store" }, "session store initialized");
    return store;
  }

  appLogger.info({ provider: "memory", subsystem: "session-store" }, "session store initialized");
  return new MemorySessionStore();
}

/**
 * Gets the singleton session store instance.
 * Creates and connects to the store on first call based on application configuration.
 * @returns A promise that resolves to the session store
 */
export async function getSessionStore(): Promise<ISessionStore> {
  if (!sessionStorePromise) {
    const config = loadConfig();
    sessionStorePromise = createSessionStore(config.session).catch((error) => {
      // Reset promise so next call retries
      sessionStorePromise = null;
      throw error;
    });
  }
  return sessionStorePromise;
}

/**
 * Resets the session store singleton.
 * Useful for testing and graceful shutdown.
 */
export async function resetSessionStore(): Promise<void> {
  if (sessionStorePromise) {
    try {
      const store = await sessionStorePromise;
      if (store.disconnect) {
        await store.disconnect();
      }
    } catch {
      // Ignore errors during reset
    }
    sessionStorePromise = null;
  }
}

/**
 * Legacy synchronous SessionStore class for backwards compatibility.
 * New code should use getSessionStore() for async access.
 * @deprecated Use getSessionStore() for new code
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  createSession(input: CreateSessionInput, ttlSeconds: number, expiresAtMsOverride?: number): SessionRecord {
    const session = buildSessionRecord(input, ttlSeconds, expiresAtMsOverride);
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id: string): SessionRecord | undefined {
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

  revokeSession(id: string): boolean {
    return this.sessions.delete(id);
  }

  clear(): void {
    this.sessions.clear();
  }

  cleanupExpired(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now >= Date.parse(session.expiresAt)) {
        this.sessions.delete(id);
      }
    }
  }
}

/**
 * Legacy singleton for backwards compatibility during migration.
 * New code should use getSessionStore() instead.
 * @deprecated Use getSessionStore() for new code
 */
export const sessionStore = new SessionStore();
