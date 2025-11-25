import { z } from "zod";

/**
 * Normalize roles array by trimming, removing empty strings, deduplicating,
 * and sorting alphabetically.
 */
export function normalizeRoles(roles: string[]): string[] {
  return Array.from(
    new Set(roles.map((role) => role.trim()).filter((role) => role.length > 0)),
  ).sort((a, b) => a.localeCompare(b));
}

/**
 * Zod schema for SessionRecord validation at process boundaries.
 * Used to validate JSON parsed from Redis.
 */
export const SessionRecordSchema = z.object({
  id: z.string(),
  subject: z.string(),
  email: z.string().optional(),
  name: z.string().optional(),
  tenantId: z.string().optional(),
  roles: z.array(z.string()),
  scopes: z.array(z.string()),
  issuedAt: z.string(),
  expiresAt: z.string(),
  claims: z.record(z.string(), z.unknown()),
});
