export function keyForTenant(
  tenantId: string | undefined,
  key: string,
): string {
  if (!tenantId) {
    return key;
  }
  return `tenant:${tenantId}:${key}`;
}
