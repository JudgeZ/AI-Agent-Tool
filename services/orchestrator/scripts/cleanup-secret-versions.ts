#!/usr/bin/env node
/**
 * Cleanup Old Secret Versions
 *
 * This script enforces retention policies on versioned secrets by:
 * 1. Limiting the number of versions kept per secret (retain count)
 * 2. Removing versions older than a specified retention window
 *
 * The VersionedSecretsManager already handles pruning during rotate/promote operations,
 * but this script provides a standalone cleanup job for maintenance.
 *
 * Usage:
 *   node cleanup-secret-versions.js [--dry-run] [--retention-versions 5]
 *
 * Environment Variables:
 *   SECRET_RETENTION_VERSIONS - Number of versions to retain per secret (default: 5)
 *   SECRET_RETENTION_DAYS - Optional time-based retention in days (e.g., 90)
 *   DRY_RUN - Set to "true" to preview cleanup without deleting
 *   METRICS_ENABLED - Enable Prometheus metrics (default: "true")
 *   AUDIT_ENABLED - Enable audit logging (default: "true")
 *   VAULT_ENABLED - Use Vault as secrets store (default: "false")
 *   DATABASE_URL - PostgreSQL connection for postgres secrets store
 *   LOCAL_SECRETS_PATH - Path to local secrets file (default: ./secrets.json)
 *
 * Exit Codes:
 *   0 - Success
 *   1 - General error
 *   2 - Configuration error
 */

import { appLogger } from "../src/observability/logger";
import { logAuditEvent } from "../src/audit/auditLogger";
import { createCounter, createGauge } from "../src/metrics/metrics";
import { VersionedSecretsManager } from "../src/auth/VersionedSecretsManager";
import type { SecretsStore } from "../src/auth/SecretsStore";

// Metrics
const secretCleanupTotal = createCounter(
  "secret_cleanup_total",
  "Total number of secret cleanup operations"
);

const secretVersionsPrunedTotal = createCounter(
  "secret_versions_pruned_total",
  "Total number of secret versions pruned"
);

const secretsProcessedTotal = createCounter(
  "secrets_processed_total",
  "Total number of secrets processed during cleanup"
);

const secretCleanupDurationSeconds = createGauge(
  "secret_cleanup_duration_seconds",
  "Duration of last secret cleanup operation"
);

interface CleanupConfig {
  retentionVersions: number;
  retentionDays?: number;
  dryRun: boolean;
  metricsEnabled: boolean;
  auditEnabled: boolean;
  vaultEnabled: boolean;
  databaseUrl?: string;
  localSecretsPath?: string;
}

interface CleanupResult {
  secretsProcessed: number;
  versionsPruned: number;
  errors: string[];
  durationMs: number;
}

class SecretVersionCleaner {
  constructor(
    private config: CleanupConfig,
    private store: SecretsStore
  ) {}

  async execute(): Promise<CleanupResult> {
    const startTime = Date.now();

    if (this.config.auditEnabled) {
      logAuditEvent({
        action: "secrets.cleanup.initiated",
        outcome: "success",
        resource: "secret-versions",
        agent: "cleanup-cronjob",
        subject: null,
        details: {
          retentionVersions: this.config.retentionVersions,
          retentionDays: this.config.retentionDays,
          dryRun: this.config.dryRun,
        },
      });
    }

    let result: CleanupResult;
    try {
      result = await this.cleanupSecrets();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (this.config.auditEnabled) {
        logAuditEvent({
          action: "secrets.cleanup.failed",
          outcome: "failure",
          resource: "secret-versions",
          agent: "cleanup-cronjob",
          subject: null,
          details: {
            error: errorMessage,
            retentionVersions: this.config.retentionVersions,
          },
        });
      }

      throw error;
    }

    const durationMs = Date.now() - startTime;
    result.durationMs = durationMs;

    if (this.config.metricsEnabled) {
      secretCleanupTotal.inc();
      secretsProcessedTotal.inc(result.secretsProcessed);
      secretVersionsPrunedTotal.inc(result.versionsPruned);
      secretCleanupDurationSeconds.set(durationMs / 1000);
    }

    if (this.config.auditEnabled) {
      logAuditEvent({
        action: "secrets.cleanup.completed",
        outcome: "success",
        resource: "secret-versions",
        agent: "cleanup-cronjob",
        subject: null,
        details: {
          secretsProcessed: result.secretsProcessed,
          versionsPruned: result.versionsPruned,
          durationMs,
          errors: result.errors,
          dryRun: this.config.dryRun,
        },
      });
    }

    return result;
  }

  private async cleanupSecrets(): Promise<CleanupResult> {
    const result: CleanupResult = {
      secretsProcessed: 0,
      versionsPruned: 0,
      errors: [],
      durationMs: 0,
    };

    // Calculate retention window if retention days is specified
    const retentionWindowMs = this.config.retentionDays
      ? this.config.retentionDays * 24 * 60 * 60 * 1000
      : undefined;

    const manager = new VersionedSecretsManager(this.store, {
      retain: this.config.retentionVersions,
      retentionWindowMs,
    });

    // Get all secret keys with metadata
    const secretKeys = await this.discoverSecretKeys();

    console.log(`Found ${secretKeys.length} versioned secrets to process`);

    for (const key of secretKeys) {
      try {
        const beforeVersions = await manager.listVersions(key);
        const versionCountBefore = beforeVersions.versions.length;

        if (versionCountBefore === 0) {
          console.log(`  ${key}: No versions found, skipping`);
          continue;
        }

        result.secretsProcessed++;

        // The VersionedSecretsManager automatically prunes expired versions
        // during listVersions() if retentionWindowMs is set, but we need to
        // enforce version count limits explicitly
        if (versionCountBefore > this.config.retentionVersions) {
          const versionsToRemove =
            versionCountBefore - this.config.retentionVersions;

          if (this.config.dryRun) {
            console.log(
              `  [DRY RUN] ${key}: Would prune ${versionsToRemove} old versions (${versionCountBefore} → ${this.config.retentionVersions})`
            );
            result.versionsPruned += versionsToRemove;
          } else {
            // Trigger pruning by rotating to current value
            const current = await manager.getCurrentValue(key);
            if (current) {
              await manager.rotate(key, current.value, {
                retain: this.config.retentionVersions,
                labels: current.labels,
              });

              const afterVersions = await manager.listVersions(key);
              const actuallyPruned =
                versionCountBefore - afterVersions.versions.length;

              console.log(
                `  ${key}: Pruned ${actuallyPruned} old versions (${versionCountBefore} → ${afterVersions.versions.length})`
              );
              result.versionsPruned += actuallyPruned;
            }
          }
        } else {
          console.log(
            `  ${key}: Within retention limit (${versionCountBefore} versions)`
          );
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to process ${key}: ${errorMessage}`);
        appLogger.error({ key, error: errorMessage }, "Secret cleanup failed");
      }
    }

    return result;
  }

  private async discoverSecretKeys(): Promise<string[]> {
    // Discover all versioned secrets by finding all metadata keys
    const allKeys = await this.getAllStoreKeys();
    const metadataKeys = allKeys.filter((key) => key.startsWith("secretmeta:"));
    return metadataKeys.map((key) => key.replace(/^secretmeta:/, ""));
  }

  private async getAllStoreKeys(): Promise<string[]> {
    // This is a simplified approach - in production, you'd need to implement
    // a proper key listing method in each SecretsStore implementation
    // For now, we'll work with known secret keys

    // Common secret keys used in the application
    const knownSecretKeys = [
      "jwt-secret",
      "session-secret",
      "encryption-key",
      "api-key",
      "webhook-secret",
      "oauth-client-secret",
    ];

    const existingKeys: string[] = [];
    for (const key of knownSecretKeys) {
      try {
        const metaKey = `secretmeta:${key}`;
        const metadata = await this.store.get(metaKey);
        if (metadata) {
          existingKeys.push(metaKey);
        }
      } catch {
        // Key doesn't exist, skip
      }
    }

    if (existingKeys.length === 0) {
      console.warn(
        "No versioned secrets found. The cleanup script currently works with known secret keys."
      );
      console.warn(
        "To scan all secrets, implement a list() method in your SecretsStore."
      );
    }

    return existingKeys;
  }
}

function parseConfig(): CleanupConfig {
  const retentionVersions = parseInt(
    process.env.SECRET_RETENTION_VERSIONS || "5",
    10
  );

  if (isNaN(retentionVersions) || retentionVersions < 1) {
    console.error("Invalid SECRET_RETENTION_VERSIONS value");
    process.exit(2);
  }

  let retentionDays: number | undefined;
  if (process.env.SECRET_RETENTION_DAYS) {
    retentionDays = parseInt(process.env.SECRET_RETENTION_DAYS, 10);
    if (isNaN(retentionDays) || retentionDays <= 0) {
      console.error("Invalid SECRET_RETENTION_DAYS value");
      process.exit(2);
    }
  }

  return {
    retentionVersions,
    retentionDays,
    dryRun: process.env.DRY_RUN === "true",
    metricsEnabled: process.env.METRICS_ENABLED !== "false",
    auditEnabled: process.env.AUDIT_ENABLED !== "false",
    vaultEnabled: process.env.VAULT_ENABLED === "true",
    databaseUrl: process.env.DATABASE_URL,
    localSecretsPath: process.env.LOCAL_SECRETS_PATH,
  };
}

async function createSecretsStore(config: CleanupConfig): Promise<SecretsStore> {
  if (config.vaultEnabled) {
    // Vault store
    const { VaultStore } = await import("../src/auth/VaultStore");
    const { createVaultClient } = await import("../src/auth/vaultClient");

    const vaultClient = await createVaultClient({
      address: process.env.VAULT_ADDR || "https://vault.default.svc:8200",
      authMethod:
        (process.env.VAULT_AUTH_METHOD as "kubernetes" | "token") ||
        "kubernetes",
      role: process.env.VAULT_ROLE,
      namespace: process.env.VAULT_NAMESPACE,
    });

    return new VaultStore(vaultClient, {
      mountPath: process.env.VAULT_MOUNT_PATH || "secret",
      keyPrefix: process.env.VAULT_KEY_PREFIX || "oss-ai-agent-tool/",
    });
  } else if (config.databaseUrl) {
    // PostgreSQL store
    const { PostgresSecretsStore } = await import(
      "../src/auth/PostgresSecretsStore"
    );
    return new PostgresSecretsStore(config.databaseUrl);
  } else {
    // Local file store (default)
    const { LocalSecretsStore } = await import("../src/auth/LocalSecretsStore");
    return new LocalSecretsStore(
      config.localSecretsPath || "./secrets.json"
    );
  }
}

async function main() {
  console.log("Starting secret version cleanup...");

  const config = parseConfig();

  console.log("Configuration:");
  console.log(`  Retention (versions): ${config.retentionVersions}`);
  if (config.retentionDays) {
    console.log(`  Retention (days): ${config.retentionDays}`);
  }
  console.log(`  Dry Run: ${config.dryRun}`);
  console.log(`  Vault Enabled: ${config.vaultEnabled}`);

  let store: SecretsStore;
  try {
    store = await createSecretsStore(config);
  } catch (error) {
    console.error("Failed to create secrets store:", error);
    process.exit(2);
  }

  const cleaner = new SecretVersionCleaner(config, store);

  try {
    const result = await cleaner.execute();

    console.log("\nCleanup completed successfully:");
    console.log(`  Secrets processed: ${result.secretsProcessed}`);
    console.log(`  Versions pruned: ${result.versionsPruned}`);
    console.log(`  Duration: ${result.durationMs}ms`);

    if (result.errors.length > 0) {
      console.log(`  Errors: ${result.errors.length}`);
      result.errors.forEach((error) => console.error(`    - ${error}`));
    }

    process.exit(0);
  } catch (error) {
    console.error("Secret cleanup failed:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { SecretVersionCleaner, CleanupConfig, CleanupResult };
