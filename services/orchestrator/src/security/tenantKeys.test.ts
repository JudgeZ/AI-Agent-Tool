import { randomBytes } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import type { CurrentSecret, VersionInfo, VersionedSecretsManager } from "../auth/VersionedSecretsManager.js";
import { TenantKeyManager } from "./tenantKeys.js";

class StubVersionedSecretsManager
  implements Pick<VersionedSecretsManager, "getCurrentValue" | "getValue" | "rotate">
{
  private readonly values = new Map<
    string,
    {
      current?: CurrentSecret;
      versions: Map<string, { value: string; createdAt: string; labels?: Record<string, string> }>;
    }
  >();
  public readonly rotations: string[] = [];
  private versionCounter = 0;

  async rotate(key: string, value: string, options?: { labels?: Record<string, string> }): Promise<VersionInfo> {
    const entry = this.ensureEntry(key);
    const version = `v-${this.versionCounter++}`;
    this.rotations.push(key);
    const createdAt = new Date().toISOString();
    entry.versions.set(version, { value, createdAt, labels: options?.labels });
    entry.current = { value, version, createdAt, labels: options?.labels };
    return { id: version, createdAt, isCurrent: true, labels: options?.labels };
  }

  async getCurrentValue(key: string): Promise<CurrentSecret | undefined> {
    return this.values.get(key)?.current;
  }

  async getValue(key: string, versionId: string): Promise<CurrentSecret | undefined> {
    const entry = this.values.get(key);
    if (!entry) {
      return undefined;
    }
    const version = entry.versions.get(versionId);
    if (!version) {
      return undefined;
    }
    return { value: version.value, version: versionId, createdAt: version.createdAt, labels: version.labels };
  }

  async simulateExternalRotation(key: string, value: string): Promise<void> {
    const entry = this.ensureEntry(key);
    const version = `external-${this.versionCounter++}`;
    const createdAt = new Date().toISOString();
    entry.versions.set(version, { value, createdAt });
    entry.current = { value, version, createdAt };
  }

  private ensureEntry(key: string): {
    current?: CurrentSecret;
    versions: Map<string, { value: string; createdAt: string; labels?: Record<string, string> }>;
  } {
    let entry = this.values.get(key);
    if (!entry) {
      entry = { versions: new Map() };
      this.values.set(key, entry);
    }
    return entry;
  }
}

describe("TenantKeyManager", () => {
  let stub: StubVersionedSecretsManager;
  let manager: TenantKeyManager;

  beforeEach(() => {
    stub = new StubVersionedSecretsManager();
    manager = new TenantKeyManager(stub as unknown as VersionedSecretsManager);
  });

  it("encrypts and decrypts artifacts with tenant-specific keys", async () => {
    const payload = await manager.encryptArtifact("Tenant-A", Buffer.from("secret-data"));
    expect(payload.tenantId).toBe("tenant-a");
    expect(payload.algorithm).toBe("aes-256-gcm");

    const stored = await stub.getCurrentValue("tenant:tenant-a:cmek:plan-artifacts");
    expect(stored?.version).toBe(payload.keyVersion);
    expect(stored).toBeDefined();
    const plaintext = await manager.decryptArtifact(payload);
    expect(plaintext.toString("utf-8")).toBe("secret-data");
  });

  it("rotates a new key when requested and caches it", async () => {
    const version = await manager.rotateTenantKey("ACME");
    expect(version).toBe("v-0");
    expect(stub.rotations).toEqual(["tenant:acme:cmek:plan-artifacts"]);

    await manager.encryptArtifact("ACME", Buffer.from("data"));
    expect(stub.rotations).toHaveLength(1);
  });

  it("refreshes cached keys when an external rotation occurs", async () => {
    const first = await manager.encryptArtifact("Tenant-A", Buffer.from("data-1"));
    expect(first.keyVersion).toBe("v-0");

    const newKey = randomBytes(32).toString("base64");
    await stub.simulateExternalRotation("tenant:tenant-a:cmek:plan-artifacts", newKey);

    const second = await manager.encryptArtifact("Tenant-A", Buffer.from("data-2"));
    expect(second.keyVersion).not.toBe(first.keyVersion);
  });

  it("avoids duplicate rotations when concurrent requests arrive", async () => {
    const buffers = [Buffer.from("a"), Buffer.from("b")];
    await Promise.all(buffers.map((buf) => manager.encryptArtifact("Race", buf)));
    expect(stub.rotations).toEqual(["tenant:race:cmek:plan-artifacts"]);
  });

  it("falls back to the global tenant when the identifier is invalid", async () => {
    const payload = await manager.encryptArtifact("   ", Buffer.from("global"));
    expect(payload.tenantId).toBe("global");
    const stored = await stub.getCurrentValue("tenant:global:cmek:plan-artifacts");
    expect(stored).toBeDefined();
  });
});
