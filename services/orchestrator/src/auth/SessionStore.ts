import { randomUUID } from "node:crypto";

export type SessionTokens = {
  idToken?: string;
  accessToken?: string;
  refreshToken?: string;
};

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
  tokens: SessionTokens;
};

export type CreateSessionInput = {
  subject: string;
  email?: string;
  name?: string;
  tenantId?: string;
  roles: string[];
  scopes: string[];
  claims: Record<string, unknown>;
  tokens: SessionTokens;
};

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  createSession(input: CreateSessionInput, ttlSeconds: number, expiresAtMsOverride?: number): SessionRecord {
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
      tokens: { ...input.tokens }
    };

    this.sessions.set(id, session);
    return session;
  }

  getSession(id: string): SessionRecord | undefined {
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

export const sessionStore = new SessionStore();
