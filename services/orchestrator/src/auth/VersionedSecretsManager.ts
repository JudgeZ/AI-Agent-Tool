import { randomUUID } from "node:crypto";

import type { SecretsStore } from "./SecretsStore.js";

type Labels = Record<string, string>;

type StoredVersion = {
  id: string;
  createdAt: string;
  labels?: Labels;
};

type StoredMetadata = {
  currentVersion?: string;
  versions: StoredVersion[];
  retain: number;
};

type RotateOptions = {
  labels?: Labels;
  retain?: number;
};

type VersionInfo = StoredVersion & {
  isCurrent: boolean;
};

type CurrentSecret = {
  value: string;
  version: string;
  createdAt?: string;
  labels?: Labels;
};

const DEFAULT_RETAIN_COUNT = 5;

function clampRetain(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value) || value < 1) {
    return Math.max(1, Math.floor(fallback));
  }
  return Math.floor(value);
}

export class VersionedSecretsManager {
  private readonly store: SecretsStore;
  private readonly defaultRetain: number;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    store: SecretsStore,
    options?: {
      retain?: number;
      now?: () => Date;
      idFactory?: () => string;
    },
  ) {
    this.store = store;
    this.defaultRetain = clampRetain(options?.retain, DEFAULT_RETAIN_COUNT);
    this.now = options?.now ?? (() => new Date());
    this.createId = options?.idFactory ?? (() => randomUUID());
  }

  async rotate(key: string, value: string, options?: RotateOptions): Promise<VersionInfo> {
    const metadata = await this.readMetadata(key);
    const retain = clampRetain(
      options?.retain ?? metadata.retain ?? this.defaultRetain,
      this.defaultRetain,
    );
    const newVersion: StoredVersion = {
      id: this.createId(),
      createdAt: this.now().toISOString(),
      ...(options?.labels ? { labels: { ...options.labels } } : {}),
    };

    await this.store.set(key, value);
    await this.store.set(this.versionKey(key, newVersion.id), value);

    const mergedVersions = [newVersion, ...metadata.versions.filter((version) => version.id !== newVersion.id)];
    const retainedVersions = mergedVersions.slice(0, retain);
    const removedVersions = mergedVersions.slice(retain);

    metadata.currentVersion = newVersion.id;
    metadata.versions = retainedVersions;
    metadata.retain = retain;

    await this.writeMetadata(key, metadata);

    await Promise.all(
      removedVersions.map((version) => this.store.delete(this.versionKey(key, version.id)).catch(() => undefined)),
    );

    return this.toVersionInfo(newVersion, metadata.currentVersion);
  }

  async promote(key: string, versionId: string): Promise<VersionInfo> {
    const metadata = await this.readMetadata(key);
    const target = metadata.versions.find((version) => version.id === versionId);
    if (!target) {
      throw new Error(`version ${versionId} not found for secret ${key}`);
    }

    const storedValue = await this.store.get(this.versionKey(key, versionId));
    if (storedValue === undefined) {
      throw new Error(`stored value for version ${versionId} is missing`);
    }

    await this.store.set(key, storedValue);

    metadata.currentVersion = versionId;
    metadata.versions = [
      target,
      ...metadata.versions.filter((version) => version.id !== versionId),
    ];

    await this.writeMetadata(key, metadata);

    return this.toVersionInfo(target, metadata.currentVersion);
  }

  async listVersions(key: string): Promise<{
    currentVersion?: string;
    retain: number;
    versions: VersionInfo[];
  }> {
    const metadata = await this.readMetadata(key);
    return {
      currentVersion: metadata.currentVersion,
      retain: metadata.retain,
      versions: metadata.versions.map((version) => this.toVersionInfo(version, metadata.currentVersion)),
    };
  }

  async getCurrentValue(key: string): Promise<CurrentSecret | undefined> {
    const metadata = await this.readMetadata(key);
    if (!metadata.currentVersion) {
      return undefined;
    }
    const value = await this.store.get(key);
    if (value === undefined) {
      return undefined;
    }
    const currentVersion = metadata.versions.find((version) => version.id === metadata.currentVersion);
    return {
      value,
      version: metadata.currentVersion,
      createdAt: currentVersion?.createdAt,
      labels: currentVersion?.labels,
    };
  }

  async clear(key: string): Promise<void> {
    const metadata = await this.readMetadata(key);
    const versionKeys = metadata.versions.map((version) => this.versionKey(key, version.id));
    await Promise.all(
      [
        this.store.delete(key),
        this.store.delete(this.metadataKey(key)),
        ...versionKeys.map((storedKey) => this.store.delete(storedKey)),
      ].map((promise) => promise.catch(() => undefined)),
    );
  }

  private metadataKey(key: string): string {
    return `secretmeta:${key}`;
  }

  private versionKey(key: string, versionId: string): string {
    return `secretver:${key}:${versionId}`;
  }

  private async readMetadata(key: string): Promise<StoredMetadata> {
    const raw = await this.store.get(this.metadataKey(key));
    if (!raw) {
      return { currentVersion: undefined, versions: [], retain: this.defaultRetain };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoredMetadata>;
      return {
        currentVersion: parsed.currentVersion,
        versions: Array.isArray(parsed.versions)
          ? parsed.versions
              .filter((item): item is StoredVersion =>
                typeof item?.id === "string" && typeof item?.createdAt === "string",
              )
              .map((item) => ({
                id: item.id,
                createdAt: item.createdAt,
                ...(item.labels && typeof item.labels === "object"
                  ? {
                      labels: Object.fromEntries(
                        Object.entries(item.labels as Record<string, unknown>)
                          .filter((entry): entry is [string, string] =>
                            typeof entry[0] === "string" && typeof entry[1] === "string",
                          ),
                      ),
                    }
                  : {}),
              }))
          : [],
        retain: clampRetain(parsed.retain, this.defaultRetain),
      };
    } catch (error) {
      throw new Error(`failed to parse secret metadata for ${key}: ${(error as Error).message}`);
    }
  }

  private async writeMetadata(key: string, metadata: StoredMetadata): Promise<void> {
    const payload = JSON.stringify(metadata);
    await this.store.set(this.metadataKey(key), payload);
  }

  private toVersionInfo(version: StoredVersion, currentVersionId: string | undefined): VersionInfo {
    return {
      ...version,
      isCurrent: currentVersionId === version.id,
    };
  }
}

export type { VersionInfo, CurrentSecret };
