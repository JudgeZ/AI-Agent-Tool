import { randomUUID } from "node:crypto";

import type { CreateSessionInput, SessionRecord } from "./ISessionStore.js";

/**
 * Normalizes roles by deduplicating, trimming, and sorting.
 */
export function normalizeRoles(roles: string[]): string[] {
  return Array.from(new Set(roles.map((role) => role.trim()).filter((role) => role.length > 0))).sort((a, b) =>
    a.localeCompare(b),
  );
}

/**
 * Normalizes scopes by deduplicating and sorting.
 */
export function normalizeScopes(scopes: string[]): string[] {
  return Array.from(new Set(scopes)).sort();
}

/**
 * Builds a SessionRecord from input parameters.
 * Generates a new UUID for the session ID.
 */
export function buildSessionRecord(
  input: CreateSessionInput,
  ttlSeconds: number,
  expiresAtMsOverride?: number,
): SessionRecord {
  const id = randomUUID();
  const issuedAtMs = Date.now();
  const ttlMs = Math.max(1, ttlSeconds) * 1000;
  const expiryCandidate = expiresAtMsOverride ?? issuedAtMs + ttlMs;
  const expiresAtMs = Math.min(expiryCandidate, issuedAtMs + ttlMs);

  return {
    id,
    subject: input.subject,
    email: input.email,
    name: input.name,
    tenantId: input.tenantId,
    roles: normalizeRoles(input.roles),
    scopes: normalizeScopes(input.scopes),
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    claims: { ...input.claims },
  };
}

/**
 * Checks if a session has expired.
 */
export function isSessionExpired(session: SessionRecord): boolean {
  return Date.now() >= Date.parse(session.expiresAt);
}

/**
 * Calculates the remaining TTL in milliseconds for a session.
 * Returns 0 if the session has already expired.
 */
export function getSessionTtlMs(session: SessionRecord): number {
  const remaining = Date.parse(session.expiresAt) - Date.now();
  return Math.max(0, remaining);
}
