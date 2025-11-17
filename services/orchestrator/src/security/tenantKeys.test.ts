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
  public lastRetain?: number;

  async rotate(
    key: string,
    value: string,
    options?: { labels?: Record<string, string>; retain?: number },
  ): Promise<VersionInfo> {
    const entry = this.ensureEntry(key);
    const version = `v-${this.versionCounter++}`;
    this.rotations.push(key);
    this.lastRetain = options?.retain;
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

  corruptCurrentValue(key: string, value: string): void {
    const entry = this.ensureEntry(key);
    if (entry.current) {
      entry.current.value = value;
      const stored = entry.versions.get(entry.current.version);
      if (stored) {
        stored.value = value;
      }
    }
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

  it("sets an effectively unbounded retain count for tenant CMEK versions", async () => {
    await manager.encryptArtifact("Tenant-A", Buffer.from("payload"));
    expect(stub.lastRetain).toBe(Number.MAX_SAFE_INTEGER);
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

  it("rotates a new key when the stored payload becomes invalid", async () => {
    await manager.encryptArtifact("Tenant-A", Buffer.from("first"));
    const keyName = "tenant:tenant-a:cmek:plan-artifacts";
    stub.corruptCurrentValue(keyName, Buffer.from("short").toString("base64"));

    const payload = await manager.encryptArtifact("Tenant-A", Buffer.from("second"));

    expect(payload.keyVersion).toBe("v-1");
    expect(stub.rotations).toEqual([keyName, keyName]);
  });

  it("uses the global tenant when the identifier is omitted", async () => {
    const payload = await manager.encryptArtifact(undefined, Buffer.from("global"));
    expect(payload.tenantId).toBe("global");
    const stored = await stub.getCurrentValue("tenant:global:cmek:plan-artifacts");
    expect(stored).toBeDefined();
  });

  it("rejects blank tenant identifiers", async () => {
    await expect(manager.encryptArtifact("   ", Buffer.from("bad"))).rejects.toThrow(
      /tenant identifier must not be blank/,
    );
  });

  it("rejects tenant identifiers with invalid characters", async () => {
    await expect(manager.encryptArtifact("tenant@acme", Buffer.from("bad"))).rejects.toThrow(
      /tenant identifier contains invalid characters/,
    );
  });

  it("rejects artifacts that exceed the maximum supported size", async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
    await expect(manager.encryptArtifact("Tenant-A", oversized)).rejects.toThrow(
      /maximum supported size/,
    );
  });
});
