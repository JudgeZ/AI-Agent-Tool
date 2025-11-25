import { randomUUID } from "node:crypto";

import type { ISessionStore } from "./ISessionStore.js";

function normalizeRoles(roles: string[]): string[] {
  return Array.from(
    new Set(roles.map(role => role.trim()).filter(role => role.length > 0))
  ).sort((a, b) => a.localeCompare(b));
}

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
 * In-memory session store implementation.
 *
 * Suitable for development and single-instance deployments.
 * For horizontal scaling, use RedisSessionStore instead.
 *
 * LIMITATIONS:
 * - Sessions are lost on process restart
 * - Not shared across multiple instances
 * - Memory usage grows with active sessions
 */
export class MemorySessionStore implements ISessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  async createSession(
    input: CreateSessionInput,
    ttlSeconds: number,
    expiresAtMsOverride?: number,
  ): Promise<SessionRecord> {
    const id = randomUUID();
    const issuedAtMs = Date.now();
    const ttlMs = Math.max(1, ttlSeconds) * 1000;
    const expiryCandidate = expiresAtMsOverride ?? issuedAtMs + ttlMs;
    const expiresAtMs = Math.min(expiryCandidate, issuedAtMs + ttlMs);

    const session: SessionRecord = {
      id,
      subject: input.subject,
      email: input.email,
      name: input.name,
      tenantId: input.tenantId,
      roles: normalizeRoles(input.roles),
      scopes: Array.from(new Set(input.scopes)).sort(),
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      claims: { ...input.claims },
    };

    this.sessions.set(id, session);
    return session;
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const session = this.sessions.get(id);
    if (!session) {
      return undefined;
    }
    if (Date.now() >= Date.parse(session.expiresAt)) {
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

  async close(): Promise<void> {
    this.sessions.clear();
  }
}

/**
 * @deprecated Use MemorySessionStore directly or createSessionStore() factory.
 * This alias exists for backward compatibility.
 */
export const SessionStore = MemorySessionStore;

/**
 * Default singleton session store instance.
 * @deprecated Prefer dependency injection with createSessionStore() factory.
 */
export const sessionStore: ISessionStore = new MemorySessionStore();
