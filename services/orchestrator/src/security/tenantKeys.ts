import { createCipheriv, randomBytes } from "node:crypto";

import { getVersionedSecretsManager } from "../providers/ProviderRegistry.js";
import { appLogger } from "../observability/logger.js";
import type { CurrentSecret, VersionInfo, VersionedSecretsManager } from "../auth/VersionedSecretsManager.js";

const ARTIFACT_KEY_SUFFIX = "cmek:plan-artifacts";
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const ALGORITHM = "aes-256-gcm";
const TENANT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const GLOBAL_TENANT_ID = "global";

export type EncryptedArtifactPayload = {
  version: 1;
  algorithm: typeof ALGORITHM;
  tenantId: string;
  keyVersion: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  createdAt: string;
};

type CachedKey = { key: Buffer; version: string };

export class TenantKeyManager {
  private readonly manager: VersionedSecretsManager;
  private readonly cache = new Map<string, CachedKey>();
  private readonly logger = appLogger.child({ component: "tenant-key-manager" });

  constructor(manager?: VersionedSecretsManager) {
    this.manager = manager ?? getVersionedSecretsManager();
  }

  async encryptArtifact(tenantId: string | undefined, data: Buffer): Promise<EncryptedArtifactPayload> {
    const normalizedTenant = this.normalizeTenantId(tenantId);
    const { key, version } = await this.getOrCreateKey(normalizedTenant);
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      version: 1,
      algorithm: ALGORITHM,
      tenantId: normalizedTenant,
      keyVersion: version,
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      createdAt: new Date().toISOString()
    };
  }

  async rotateTenantKey(tenantId: string): Promise<string> {
    const normalizedTenant = this.normalizeTenantId(tenantId);
    const newKey = randomBytes(KEY_LENGTH_BYTES);
    const version = await this.writeNewVersion(normalizedTenant, newKey);
    return version.id;
  }

  private async getOrCreateKey(tenantId: string): Promise<CachedKey> {
    const cached = this.cache.get(tenantId);
    if (cached) {
      return cached;
    }

    const existing = await this.manager.getCurrentValue(this.keyName(tenantId));
    if (existing?.value) {
      const decoded = this.decodeKey(existing);
      if (decoded) {
        const entry: CachedKey = { key: decoded, version: existing.version };
        this.cache.set(tenantId, entry);
        return entry;
      }
      this.logger.warn(
        {
          tenantId,
          version: existing.version
        },
        "invalid CMEK payload encountered; rotating"
      );
    }

    const newKey = randomBytes(KEY_LENGTH_BYTES);
    const version = await this.writeNewVersion(tenantId, newKey);
    const entry: CachedKey = { key: newKey, version: version.id };
    this.cache.set(tenantId, entry);
    return entry;
  }

  private decodeKey(secret: CurrentSecret): Buffer | undefined {
    try {
      const buffer = Buffer.from(secret.value, "base64");
      if (buffer.length !== KEY_LENGTH_BYTES) {
        return undefined;
      }
      return buffer;
    } catch (error) {
      this.logger.warn(
        {
          tenantId: secret.labels?.tenant ?? GLOBAL_TENANT_ID,
          err: (error as Error).message
        },
        "failed to decode tenant CMEK"
      );
      return undefined;
    }
  }

  private keyName(tenantId: string): string {
    return `tenant:${tenantId}:${ARTIFACT_KEY_SUFFIX}`;
  }

  private normalizeTenantId(candidate: string | undefined): string {
    if (!candidate) {
      return GLOBAL_TENANT_ID;
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
      return GLOBAL_TENANT_ID;
    }
    if (!TENANT_ID_PATTERN.test(trimmed)) {
      return GLOBAL_TENANT_ID;
    }
    return trimmed.toLowerCase();
  }

  private async writeNewVersion(tenantId: string, key: Buffer): Promise<VersionInfo> {
    const payload = key.toString("base64");
    const version = await this.manager.rotate(this.keyName(tenantId), payload, {
      labels: { tenant: tenantId }
    });
    this.cache.set(tenantId, { key, version: version.id });
    return version;
  }
}

let tenantKeyManager: TenantKeyManager | undefined;

export function getTenantKeyManager(): TenantKeyManager {
  if (!tenantKeyManager) {
    tenantKeyManager = new TenantKeyManager();
  }
  return tenantKeyManager;
}

export function __setTenantKeyManagerForTests(manager?: TenantKeyManager): void {
  tenantKeyManager = manager;
}
