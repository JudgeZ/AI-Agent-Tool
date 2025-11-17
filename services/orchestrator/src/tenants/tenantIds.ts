export const TENANT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export class InvalidTenantIdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTenantIdentifierError";
  }
}

type NormalizeTenantIdResult =
  | { tenantId?: string; error?: undefined }
  | { tenantId?: undefined; error: InvalidTenantIdentifierError };

export function normalizeTenantIdInput(
  candidate: string | undefined | null,
): NormalizeTenantIdResult {
  if (candidate === undefined || candidate === null) {
    return { tenantId: undefined };
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return { error: new InvalidTenantIdentifierError("tenant identifier must not be blank") };
  }
  if (!TENANT_ID_PATTERN.test(trimmed)) {
    return {
      error: new InvalidTenantIdentifierError(
        "tenant identifier may only include letters, numbers, period, underscore, or dash",
      ),
    };
  }
  return { tenantId: trimmed.toLowerCase() };
}
