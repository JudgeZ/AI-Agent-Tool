import { beforeEach, describe, expect, it } from "vitest";

import type { SecretsStore } from "./SecretsStore.js";
import { VersionedSecretsManager } from "./VersionedSecretsManager.js";

describe("VersionedSecretsManager retention bounds", () => {
  let data: Map<string, string>;
  let store: SecretsStore;

  beforeEach(() => {
    data = new Map();
    store = {
      async set(key, value) {
        data.set(key, value);
      },
      async get(key) {
        return data.get(key);
      },
      async delete(key) {
        data.delete(key);
      },
    };
  });

  it("falls back to the default retain count when configured retain is Infinity", async () => {
    const manager = new VersionedSecretsManager(store, { retain: Number.POSITIVE_INFINITY });

    await manager.rotate("secret", "value-0");
    const versions = await manager.listVersions("secret");

    expect(versions.retain).toBe(5);
    expect(Number.isFinite(versions.retain)).toBe(true);
  });

  it("ignores infinite retain requests during rotation", async () => {
    let idCounter = 0;
    let timestamp = Date.UTC(2024, 0, 1);
    const manager = new VersionedSecretsManager(store, {
      idFactory: () => {
        const id = `v-${idCounter}`;
        idCounter += 1;
        return id;
      },
      now: () => {
        timestamp += 1000;
        return new Date(timestamp);
      },
    });

    for (let index = 0; index < 7; index += 1) {
      await manager.rotate("secret", `value-${index}`, { retain: Number.POSITIVE_INFINITY });
    }

    const versions = await manager.listVersions("secret");

    expect(versions.retain).toBe(5);
    expect(Number.isFinite(versions.retain)).toBe(true);
    expect(versions.versions).toHaveLength(5);
    const versionIds = versions.versions.map((version) => version.id);
    expect(versionIds).toEqual(["v-6", "v-5", "v-4", "v-3", "v-2"]);
    expect(versionIds).not.toContain("v-0");
    expect(versionIds).not.toContain("v-1");
  });

  it("purges non-current versions that exceed the retention window", async () => {
    let now = Date.UTC(2024, 0, 1);
    let idCounter = 0;
    const manager = new VersionedSecretsManager(store, {
      now: () => new Date(now),
      idFactory: () => `v-${idCounter++}`,
      retentionWindowMs: 1_000,
    });

    await manager.rotate("secret", "value-0");
    now += 2_000;
    await manager.rotate("secret", "value-1");

    const versions = await manager.listVersions("secret");
    expect(versions.versions).toHaveLength(1);
    expect(versions.versions[0]?.id).toBe("v-1");
    expect(data.has("secretver:secret:v-0")).toBe(false);
  });
});
