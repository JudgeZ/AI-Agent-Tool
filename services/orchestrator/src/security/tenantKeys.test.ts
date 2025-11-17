import { createDecipheriv } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import type { CurrentSecret, VersionInfo, VersionedSecretsManager } from "../auth/VersionedSecretsManager.js";
import { TenantKeyManager } from "./tenantKeys.js";

class StubVersionedSecretsManager
  implements Pick<VersionedSecretsManager, "getCurrentValue" | "rotate">
{
  private readonly values = new Map<string, { value: string; version: string; labels?: Record<string, string> }>();
  public readonly rotations: string[] = [];

  async rotate(key: string, value: string, options?: { labels?: Record<string, string> }): Promise<VersionInfo> {
    const version = `v-${this.rotations.length}`;
    this.rotations.push(key);
    const createdAt = new Date().toISOString();
    this.values.set(key, { value, version, labels: options?.labels });
    return { id: version, createdAt, isCurrent: true, labels: options?.labels };
  }

  async getCurrentValue(key: string): Promise<CurrentSecret | undefined> {
    const entry = this.values.get(key);
    if (!entry) {
      return undefined;
    }
    return { value: entry.value, version: entry.version, labels: entry.labels };
  }
}

describe("TenantKeyManager", () => {
  let stub: StubVersionedSecretsManager;
  let manager: TenantKeyManager;

  beforeEach(() => {
    stub = new StubVersionedSecretsManager();
    manager = new TenantKeyManager(stub as unknown as VersionedSecretsManager);
  });

  it("encrypts artifacts with tenant-specific keys", async () => {
    const payload = await manager.encryptArtifact("Tenant-A", Buffer.from("secret-data"));
    expect(payload.tenantId).toBe("tenant-a");
    expect(payload.algorithm).toBe("aes-256-gcm");

    const stored = await stub.getCurrentValue("tenant:tenant-a:cmek:plan-artifacts");
    expect(stored?.version).toBe(payload.keyVersion);
    expect(stored).toBeDefined();
    const key = Buffer.from(stored!.value, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64")),
      decipher.final()
    ]);
    expect(plaintext.toString("utf-8")).toBe("secret-data");
  });

  it("rotates a new key when requested and caches it", async () => {
    const version = await manager.rotateTenantKey("ACME");
    expect(version).toBe("v-0");
    expect(stub.rotations).toEqual(["tenant:acme:cmek:plan-artifacts"]);

    await manager.encryptArtifact("ACME", Buffer.from("data"));
    expect(stub.rotations).toHaveLength(1);
  });

  it("falls back to the global tenant when the identifier is invalid", async () => {
    const payload = await manager.encryptArtifact("   ", Buffer.from("global"));
    expect(payload.tenantId).toBe("global");
    const stored = await stub.getCurrentValue("tenant:global:cmek:plan-artifacts");
    expect(stored).toBeDefined();
  });
});
