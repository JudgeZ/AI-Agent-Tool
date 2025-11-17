import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

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
  private readonly inflight = new Map<string, Promise<CachedKey>>();
  private readonly logger = appLogger.child({ component: "tenant-key-manager" });

  constructor(manager?: VersionedSecretsManager) {
    this.manager = manager ?? getVersionedSecretsManager();
  }

  async encryptArtifact(tenantId: string | undefined, data: Buffer): Promise<EncryptedArtifactPayload> {
    const normalizedTenant = this.normalizeTenantId(tenantId);
    const { key, version } = await this.getOrCreateKey(normalizedTenant);
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
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

  async decryptArtifact(payload: EncryptedArtifactPayload): Promise<Buffer> {
    if (payload.algorithm !== ALGORITHM) {
      throw new Error(`unsupported encryption algorithm: ${payload.algorithm}`);
    }
    if (payload.version !== 1) {
      throw new Error(`unsupported payload version: ${payload.version}`);
    }
    const normalizedTenant = this.normalizeTenantId(payload.tenantId);
    const key = await this.getKeyForVersion(normalizedTenant, payload.keyVersion);
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(payload.iv, "base64"),
      { authTagLength: 16 },
    );
    decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64")),
      decipher.final(),
    ]);
  }

  async rotateTenantKey(tenantId: string): Promise<string> {
    const normalizedTenant = this.normalizeTenantId(tenantId);
    const newKey = randomBytes(KEY_LENGTH_BYTES);
    const version = await this.writeNewVersion(normalizedTenant, newKey);
    return version.id;
  }

  private async getOrCreateKey(tenantId: string): Promise<CachedKey> {
    const inflight = this.inflight.get(tenantId);
    if (inflight) {
      return inflight;
    }
    const pending = this.loadOrCreateKey(tenantId);
    this.inflight.set(tenantId, pending);
    try {
      return await pending;
    } finally {
      this.inflight.delete(tenantId);
    }
  }

  private async loadOrCreateKey(tenantId: string): Promise<CachedKey> {
    const cached = this.cache.get(tenantId);
    const existing = await this.manager.getCurrentValue(this.keyName(tenantId));
    if (existing?.value) {
      const decoded = this.decodeKey(existing);
      if (decoded) {
        if (cached && cached.version === existing.version) {
          return cached;
        }
        const entry: CachedKey = { key: decoded, version: existing.version };
        this.cache.set(tenantId, entry);
        return entry;
      }
      this.logger.warn(
        {
          tenantIdHash: this.redactTenantId(tenantId),
          version: existing.version,
        },
        "invalid CMEK payload encountered; rotating",
      );
      this.cache.delete(tenantId);
    }

    if (cached) {
      return cached;
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
          tenantIdHash: this.redactTenantId(secret.labels?.tenant ?? GLOBAL_TENANT_ID),
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
    if (candidate === undefined || candidate === null) {
      return GLOBAL_TENANT_ID;
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
      throw new Error("tenant identifier must not be blank");
    }
    if (!TENANT_ID_PATTERN.test(trimmed)) {
      throw new Error("tenant identifier contains invalid characters");
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

  private async getKeyForVersion(tenantId: string, versionId: string): Promise<Buffer> {
    const secret = await this.manager.getValue(this.keyName(tenantId), versionId);
    if (!secret?.value) {
      throw new Error(`encryption key version ${versionId} is unavailable for tenant ${tenantId}`);
    }
    const decoded = this.decodeKey(secret);
    if (!decoded) {
      throw new Error(`stored key material for version ${versionId} is invalid`);
    }
    return decoded;
  }

  private redactTenantId(tenantId: string): string {
    const normalized = tenantId || GLOBAL_TENANT_ID;
    return createHash("sha256").update(normalized).digest("hex").slice(0, 8);
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
