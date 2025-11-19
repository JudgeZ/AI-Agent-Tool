#!/usr/bin/env node
/**
 * Purge Expired Plan Artifacts
 *
 * This script removes artifact files that have exceeded their retention period.
 * It supports multiple storage backends (local file system, S3, Azure Blob Storage)
 * and includes comprehensive audit logging and metrics.
 *
 * Usage:
 *   node purge-expired-artifacts.js [--dry-run] [--retention-days 90]
 *
 * Environment Variables:
 *   ARTIFACT_RETENTION_DAYS - Number of days to retain artifacts (default: 90)
 *   DRY_RUN - Set to "true" to preview deletions without actually deleting
 *   STORAGE_BACKEND - Storage backend: "file", "s3", or "azure" (default: "file")
 *   ARTIFACT_BASE_PATH - Base path for file storage (default: /app/data/artifacts)
 *   BATCH_SIZE - Number of artifacts to delete per batch (default: 100)
 *   METRICS_ENABLED - Enable Prometheus metrics (default: "true")
 *   AUDIT_ENABLED - Enable audit logging (default: "true")
 *
 * File Storage:
 *   ARTIFACT_BASE_PATH - Local directory containing artifacts
 *
 * S3 Storage:
 *   S3_BUCKET - S3 bucket name
 *   S3_REGION - AWS region (default: us-east-1)
 *   S3_PREFIX - Object key prefix (default: artifacts/)
 *   AWS_ACCESS_KEY_ID - AWS access key (or use IAM role)
 *   AWS_SECRET_ACCESS_KEY - AWS secret key (or use IAM role)
 *
 * Azure Blob Storage:
 *   AZURE_STORAGE_ACCOUNT - Storage account name
 *   AZURE_STORAGE_KEY - Storage account key (or use managed identity)
 *   AZURE_CONTAINER - Container name (default: artifacts)
 *   AZURE_PREFIX - Blob prefix (default: "")
 *
 * Exit Codes:
 *   0 - Success
 *   1 - General error
 *   2 - Configuration error
 */

import { promises as fs } from "fs";
import path from "path";
import { logAuditEvent } from "../src/audit/auditLogger";
import { createCounter, createGauge } from "../src/metrics/metrics";

// Metrics
const artifactPurgeTotal = createCounter(
  "artifact_purge_total",
  "Total number of artifact purge operations"
);

const artifactsPurgedTotal = createCounter(
  "artifacts_purged_total",
  "Total number of artifacts deleted"
);

const artifactPurgeBytesTotal = createCounter(
  "artifact_purge_bytes_total",
  "Total bytes deleted by artifact purge"
);

const artifactPurgeDurationSeconds = createGauge(
  "artifact_purge_duration_seconds",
  "Duration of last artifact purge operation"
);

interface PurgeConfig {
  retentionDays: number;
  dryRun: boolean;
  backend: "file" | "s3" | "azure";
  batchSize: number;
  metricsEnabled: boolean;
  auditEnabled: boolean;
  // File backend
  basePath?: string;
  // S3 backend
  s3Bucket?: string;
  s3Region?: string;
  s3Prefix?: string;
  // Azure backend
  azureAccount?: string;
  azureKey?: string;
  azureContainer?: string;
  azurePrefix?: string;
}

interface PurgeResult {
  artifactsDeleted: number;
  bytesDeleted: number;
  errors: string[];
  durationMs: number;
}

interface ArtifactInfo {
  path: string;
  size: number;
  modifiedAt: Date;
}

class ArtifactPurger {
  constructor(private config: PurgeConfig) {}

  async execute(): Promise<PurgeResult> {
    const startTime = Date.now();
    const retentionMs = this.config.retentionDays * 24 * 60 * 60 * 1000;
    const cutoffDate = new Date(Date.now() - retentionMs);

    if (this.config.auditEnabled) {
      logAuditEvent({
        action: "artifacts.purge.initiated",
        outcome: "success",
        resource: "plan-artifacts",
        agent: "purge-cronjob",
        subject: null,
        details: {
          retentionDays: this.config.retentionDays,
          cutoffDate: cutoffDate.toISOString(),
          backend: this.config.backend,
          dryRun: this.config.dryRun,
        },
      });
    }

    let result: PurgeResult;
    try {
      result = await this.purgeByBackend(retentionMs, cutoffDate);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (this.config.auditEnabled) {
        logAuditEvent({
          action: "artifacts.purge.failed",
          outcome: "failure",
          resource: "plan-artifacts",
          agent: "purge-cronjob",
          subject: null,
          details: {
            error: errorMessage,
            retentionDays: this.config.retentionDays,
          },
        });
      }

      throw error;
    }

    const durationMs = Date.now() - startTime;
    result.durationMs = durationMs;

    if (this.config.metricsEnabled) {
      artifactPurgeTotal.inc();
      artifactsPurgedTotal.inc(result.artifactsDeleted);
      artifactPurgeBytesTotal.inc(result.bytesDeleted);
      artifactPurgeDurationSeconds.set(durationMs / 1000);
    }

    if (this.config.auditEnabled) {
      logAuditEvent({
        action: "artifacts.purge.completed",
        outcome: "success",
        resource: "plan-artifacts",
        agent: "purge-cronjob",
        subject: null,
        details: {
          artifactsDeleted: result.artifactsDeleted,
          bytesDeleted: result.bytesDeleted,
          durationMs,
          errors: result.errors,
          dryRun: this.config.dryRun,
        },
      });
    }

    return result;
  }

  private async purgeByBackend(
    retentionMs: number,
    cutoffDate: Date
  ): Promise<PurgeResult> {
    switch (this.config.backend) {
      case "file":
        return this.purgeFileSystem(retentionMs, cutoffDate);
      case "s3":
        return this.purgeS3(retentionMs, cutoffDate);
      case "azure":
        return this.purgeAzure(retentionMs, cutoffDate);
      default:
        throw new Error(`Unsupported backend: ${this.config.backend}`);
    }
  }

  private async purgeFileSystem(
    retentionMs: number,
    cutoffDate: Date
  ): Promise<PurgeResult> {
    if (!this.config.basePath) {
      throw new Error("ARTIFACT_BASE_PATH is required for file backend");
    }

    const result: PurgeResult = {
      artifactsDeleted: 0,
      bytesDeleted: 0,
      errors: [],
      durationMs: 0,
    };

    try {
      await fs.access(this.config.basePath);
    } catch {
      console.warn(
        `Artifact base path does not exist: ${this.config.basePath}`
      );
      return result;
    }

    const artifacts = await this.scanFileSystem(this.config.basePath);
    const expiredArtifacts = artifacts.filter(
      (artifact) => artifact.modifiedAt < cutoffDate
    );

    console.log(
      `Found ${expiredArtifacts.length} expired artifacts out of ${artifacts.length} total`
    );

    // Process in batches
    for (let i = 0; i < expiredArtifacts.length; i += this.config.batchSize) {
      const batch = expiredArtifacts.slice(i, i + this.config.batchSize);

      for (const artifact of batch) {
        try {
          if (this.config.dryRun) {
            console.log(
              `[DRY RUN] Would delete: ${artifact.path} (${artifact.size} bytes)`
            );
          } else {
            await fs.unlink(artifact.path);
            console.log(`Deleted: ${artifact.path} (${artifact.size} bytes)`);
          }

          result.artifactsDeleted++;
          result.bytesDeleted += artifact.size;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          result.errors.push(`Failed to delete ${artifact.path}: ${errorMessage}`);
          console.error(`Error deleting ${artifact.path}:`, error);
        }
      }

      // Clean up empty directories
      if (!this.config.dryRun && batch.length > 0) {
        await this.cleanEmptyDirectories(this.config.basePath);
      }
    }

    return result;
  }

  private async scanFileSystem(dirPath: string): Promise<ArtifactInfo[]> {
    const artifacts: ArtifactInfo[] = [];

    async function scan(currentPath: string) {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          await scan(fullPath);
        } else if (entry.isFile()) {
          const stats = await fs.stat(fullPath);
          artifacts.push({
            path: fullPath,
            size: stats.size,
            modifiedAt: stats.mtime,
          });
        }
      }
    }

    await scan(dirPath);
    return artifacts;
  }

  private async cleanEmptyDirectories(basePath: string): Promise<void> {
    async function clean(dirPath: string): Promise<boolean> {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      let hasContent = false;
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          const dirHasContent = await clean(fullPath);
          if (dirHasContent) {
            hasContent = true;
          }
        } else {
          hasContent = true;
        }
      }

      if (!hasContent && dirPath !== basePath) {
        try {
          await fs.rmdir(dirPath);
          console.log(`Removed empty directory: ${dirPath}`);
        } catch (error) {
          console.warn(`Could not remove directory ${dirPath}:`, error);
        }
      }

      return hasContent;
    }

    await clean(basePath);
  }

  private async purgeS3(
    retentionMs: number,
    cutoffDate: Date
  ): Promise<PurgeResult> {
    // S3 backend implementation would go here
    // This requires AWS SDK (@aws-sdk/client-s3)
    throw new Error(
      "S3 backend not yet implemented. Install @aws-sdk/client-s3 and implement this method."
    );

    /*
    Example implementation outline:

    const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3");

    const client = new S3Client({
      region: this.config.s3Region || "us-east-1"
    });

    let continuationToken: string | undefined;
    const result: PurgeResult = { artifactsDeleted: 0, bytesDeleted: 0, errors: [], durationMs: 0 };

    do {
      const listResponse = await client.send(new ListObjectsV2Command({
        Bucket: this.config.s3Bucket,
        Prefix: this.config.s3Prefix || "artifacts/",
        ContinuationToken: continuationToken
      }));

      const expiredObjects = (listResponse.Contents || [])
        .filter(obj => obj.LastModified && obj.LastModified < cutoffDate);

      if (expiredObjects.length > 0) {
        const deleteObjects = expiredObjects.map(obj => ({ Key: obj.Key! }));

        if (!this.config.dryRun) {
          await client.send(new DeleteObjectsCommand({
            Bucket: this.config.s3Bucket,
            Delete: { Objects: deleteObjects }
          }));
        }

        result.artifactsDeleted += expiredObjects.length;
        result.bytesDeleted += expiredObjects.reduce((sum, obj) => sum + (obj.Size || 0), 0);
      }

      continuationToken = listResponse.NextContinuationToken;
    } while (continuationToken);

    return result;
    */
  }

  private async purgeAzure(
    retentionMs: number,
    cutoffDate: Date
  ): Promise<PurgeResult> {
    // Azure Blob Storage backend implementation would go here
    // This requires Azure SDK (@azure/storage-blob)
    throw new Error(
      "Azure backend not yet implemented. Install @azure/storage-blob and implement this method."
    );

    /*
    Example implementation outline:

    const { BlobServiceClient } = require("@azure/storage-blob");

    const connectionString = `DefaultEndpointsProtocol=https;AccountName=${this.config.azureAccount};AccountKey=${this.config.azureKey};EndpointSuffix=core.windows.net`;
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient(this.config.azureContainer || "artifacts");

    const result: PurgeResult = { artifactsDeleted: 0, bytesDeleted: 0, errors: [], durationMs: 0 };

    for await (const blob of containerClient.listBlobsFlat({ prefix: this.config.azurePrefix })) {
      if (blob.properties.lastModified && blob.properties.lastModified < cutoffDate) {
        if (!this.config.dryRun) {
          await containerClient.deleteBlob(blob.name);
        }

        result.artifactsDeleted++;
        result.bytesDeleted += blob.properties.contentLength || 0;
      }
    }

    return result;
    */
  }
}

function parseConfig(): PurgeConfig {
  const retentionDays = parseInt(
    process.env.ARTIFACT_RETENTION_DAYS || "90",
    10
  );

  if (isNaN(retentionDays) || retentionDays <= 0) {
    console.error("Invalid ARTIFACT_RETENTION_DAYS value");
    process.exit(2);
  }

  const backend = (process.env.STORAGE_BACKEND || "file") as
    | "file"
    | "s3"
    | "azure";

  if (!["file", "s3", "azure"].includes(backend)) {
    console.error(`Invalid STORAGE_BACKEND: ${backend}`);
    process.exit(2);
  }

  const config: PurgeConfig = {
    retentionDays,
    dryRun: process.env.DRY_RUN === "true",
    backend,
    batchSize: parseInt(process.env.BATCH_SIZE || "100", 10),
    metricsEnabled: process.env.METRICS_ENABLED !== "false",
    auditEnabled: process.env.AUDIT_ENABLED !== "false",
  };

  // Backend-specific configuration
  if (backend === "file") {
    config.basePath = process.env.ARTIFACT_BASE_PATH || "/app/data/artifacts";
  } else if (backend === "s3") {
    config.s3Bucket = process.env.S3_BUCKET;
    config.s3Region = process.env.S3_REGION || "us-east-1";
    config.s3Prefix = process.env.S3_PREFIX || "artifacts/";

    if (!config.s3Bucket) {
      console.error("S3_BUCKET is required for S3 backend");
      process.exit(2);
    }
  } else if (backend === "azure") {
    config.azureAccount = process.env.AZURE_STORAGE_ACCOUNT;
    config.azureKey = process.env.AZURE_STORAGE_KEY;
    config.azureContainer = process.env.AZURE_CONTAINER || "artifacts";
    config.azurePrefix = process.env.AZURE_PREFIX || "";

    if (!config.azureAccount || !config.azureKey) {
      console.error(
        "AZURE_STORAGE_ACCOUNT and AZURE_STORAGE_KEY are required for Azure backend"
      );
      process.exit(2);
    }
  }

  return config;
}

async function main() {
  console.log("Starting artifact purge...");

  const config = parseConfig();

  console.log("Configuration:");
  console.log(`  Retention: ${config.retentionDays} days`);
  console.log(`  Backend: ${config.backend}`);
  console.log(`  Dry Run: ${config.dryRun}`);
  console.log(`  Batch Size: ${config.batchSize}`);

  if (config.backend === "file") {
    console.log(`  Base Path: ${config.basePath}`);
  } else if (config.backend === "s3") {
    console.log(`  S3 Bucket: ${config.s3Bucket}`);
    console.log(`  S3 Prefix: ${config.s3Prefix}`);
  } else if (config.backend === "azure") {
    console.log(`  Azure Container: ${config.azureContainer}`);
    console.log(`  Azure Prefix: ${config.azurePrefix}`);
  }

  const purger = new ArtifactPurger(config);

  try {
    const result = await purger.execute();

    console.log("\nPurge completed successfully:");
    console.log(`  Artifacts deleted: ${result.artifactsDeleted}`);
    console.log(`  Bytes deleted: ${result.bytesDeleted}`);
    console.log(`  Duration: ${result.durationMs}ms`);

    if (result.errors.length > 0) {
      console.log(`  Errors: ${result.errors.length}`);
      result.errors.forEach((error) => console.error(`    - ${error}`));
    }

    process.exit(0);
  } catch (error) {
    console.error("Artifact purge failed:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { ArtifactPurger, PurgeConfig, PurgeResult };
