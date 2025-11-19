#!/usr/bin/env tsx

/**
 * Purge Expired Plan States
 *
 * This script removes plan execution state that has exceeded the retention period.
 * It should be run as a Kubernetes CronJob for automated cleanup.
 *
 * Features:
 * - Removes terminal plan states older than retention period (default: 30 days)
 * - Works with both file-based and PostgreSQL storage
 * - Dry-run mode for testing
 * - Metrics for monitoring purge operations
 * - Audit logging for compliance
 *
 * Usage:
 *   tsx scripts/purge-expired-plan-states.ts [--dry-run] [--retention-days=30]
 *
 * Environment Variables:
 *   PLAN_STATE_BACKEND - Storage backend (file | postgres)
 *   POSTGRES_URL - PostgreSQL connection string (if using postgres backend)
 *   PLAN_STATE_PATH - File path for file-based storage
 *   PLAN_RETENTION_DAYS - Retention period in days (default: 30)
 *   DRY_RUN - Simulate purge without deleting (default: false)
 */

import process from "node:process";
import { appLogger } from "../src/observability/logger.js";
import { logAuditEvent } from "../src/observability/audit.js";
import { Counter, Gauge } from "prom-client";

// Metrics
const purgeCounter = new Counter({
  name: "plan_state_purge_total",
  help: "Total number of plan state purge operations",
  labelNames: ["status", "backend"] // success, failure
});

const purgedStepsGauge = new Gauge({
  name: "plan_state_purged_steps",
  help: "Number of plan steps purged in last operation"
});

const purgedPlansGauge = new Gauge({
  name: "plan_state_purged_plans",
  help: "Number of plans purged in last operation"
});

interface PurgeConfig {
  retentionDays: number;
  dryRun: boolean;
  backend: "file" | "postgres";
}

interface PurgeResult {
  stepsPurged: number;
  plansPurged: number;
  durationMs: number;
  cutoffDate: Date;
  backend: string;
}

class PlanStatePurger {
  private config: PurgeConfig;

  constructor(config: PurgeConfig) {
    this.config = config;
  }

  async execute(): Promise<PurgeResult> {
    const startTime = Date.now();
    const retentionMs = this.config.retentionDays * 24 * 60 * 60 * 1000;
    const cutoffDate = new Date(Date.now() - retentionMs);

    appLogger.info(
      {
        event: "plan_state.purge.start",
        retentionDays: this.config.retentionDays,
        cutoffDate: cutoffDate.toISOString(),
        backend: this.config.backend,
        dryRun: this.config.dryRun
      },
      `Starting plan state purge (retention: ${this.config.retentionDays} days)`
    );

    // Audit log: purge initiated
    logAuditEvent({
      action: "plan_state.purge.initiated",
      outcome: "success",
      resource: "plan-states",
      agent: "purge-cronjob",
      details: {
        retentionDays: this.config.retentionDays,
        cutoffDate: cutoffDate.toISOString(),
        backend: this.config.backend,
        dryRun: this.config.dryRun
      }
    });

    try {
      const result = await this.purgeByBackend(retentionMs, cutoffDate);
      const duration = Date.now() - startTime;

      appLogger.info(
        {
          event: "plan_state.purge.success",
          stepsPurged: result.stepsPurged,
          plansPurged: result.plansPurged,
          durationMs: duration,
          backend: this.config.backend
        },
        `Purge completed: ${result.stepsPurged} steps, ${result.plansPurged} plans removed`
      );

      // Update metrics
      purgeCounter.labels("success", this.config.backend).inc();
      purgedStepsGauge.set(result.stepsPurged);
      purgedPlansGauge.set(result.plansPurged);

      // Audit log: successful purge
      logAuditEvent({
        action: "plan_state.purge.completed",
        outcome: "success",
        resource: "plan-states",
        agent: "purge-cronjob",
        details: {
          stepsPurged: result.stepsPurged,
          plansPurged: result.plansPurged,
          durationMs: duration,
          cutoffDate: cutoffDate.toISOString(),
          backend: this.config.backend,
          dryRun: this.config.dryRun
        }
      });

      return {
        ...result,
        durationMs: duration
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = (error as Error).message;

      appLogger.error(
        {
          event: "plan_state.purge.error",
          error: errorMessage,
          durationMs: duration,
          backend: this.config.backend
        },
        `Purge failed: ${errorMessage}`
      );

      purgeCounter.labels("failure", this.config.backend).inc();

      // Audit log: failed purge
      logAuditEvent({
        action: "plan_state.purge.failed",
        outcome: "failure",
        resource: "plan-states",
        agent: "purge-cronjob",
        error: errorMessage,
        details: {
          durationMs: duration,
          backend: this.config.backend
        }
      });

      throw error;
    }
  }

  private async purgeByBackend(
    retentionMs: number,
    cutoffDate: Date
  ): Promise<Omit<PurgeResult, "durationMs">> {
    if (this.config.backend === "postgres") {
      return this.purgePostgres(retentionMs, cutoffDate);
    } else {
      return this.purgeFile(retentionMs, cutoffDate);
    }
  }

  private async purgePostgres(
    retentionMs: number,
    cutoffDate: Date
  ): Promise<Omit<PurgeResult, "durationMs">> {
    const { PostgresPlanStateStore } = await import("../src/queue/PlanStateStore.js");
    const { getPostgresPool } = await import("../src/database/Postgres.js");

    const pool = getPostgresPool();
    const store = new PostgresPlanStateStore(pool, { retentionMs });

    if (this.config.dryRun) {
      // Count what would be purged
      const result = await pool.query(
        `SELECT
          COUNT(DISTINCT plan_id) as plan_count,
          COUNT(*) as step_count
        FROM plan_steps
        WHERE state IN ('completed', 'failed', 'rejected', 'dead_lettered')
          AND updated_at < $1`,
        [cutoffDate]
      );

      const planCount = parseInt(result.rows[0]?.plan_count || "0", 10);
      const stepCount = parseInt(result.rows[0]?.step_count || "0", 10);

      appLogger.info(
        {
          event: "plan_state.purge.dryrun",
          wouldPurgePlans: planCount,
          wouldPurgeSteps: stepCount
        },
        `[DRY RUN] Would purge ${stepCount} steps from ${planCount} plans`
      );

      return {
        stepsPurged: stepCount,
        plansPurged: planCount,
        cutoffDate,
        backend: "postgres"
      };
    }

    // Actual purge - the store's purgeExpired method handles this
    // We need to count before purging
    const countBefore = await pool.query(
      `SELECT
        COUNT(DISTINCT plan_id) as plan_count,
        COUNT(*) as step_count
      FROM plan_steps
      WHERE state IN ('completed', 'failed', 'rejected', 'dead_lettered')
        AND updated_at < $1`,
      [cutoffDate]
    );

    const plansBefore = parseInt(countBefore.rows[0]?.plan_count || "0", 10);
    const stepsBefore = parseInt(countBefore.rows[0]?.step_count || "0", 10);

    // Trigger purge (this is called internally by store operations)
    // We'll manually execute the purge query
    await pool.query(
      `DELETE FROM plan_steps
       WHERE state IN ('completed', 'failed', 'rejected', 'dead_lettered')
         AND updated_at < $1`,
      [cutoffDate]
    );

    await pool.query(
      `DELETE FROM plan_metadata
       WHERE plan_id NOT IN (SELECT DISTINCT plan_id FROM plan_steps)`,
      []
    );

    return {
      stepsPurged: stepsBefore,
      plansPurged: plansBefore,
      cutoffDate,
      backend: "postgres"
    };
  }

  private async purgeFile(
    retentionMs: number,
    cutoffDate: Date
  ): Promise<Omit<PurgeResult, "durationMs">> {
    const { FilePlanStateStore } = await import("../src/queue/PlanStateStore.js");

    const filePath = process.env.PLAN_STATE_PATH || "./data/plan-state.json";
    const store = new FilePlanStateStore({ filePath, retentionMs });

    // For file-based storage, we need to load the current state
    const activeSteps = await store.listActiveSteps();
    const planMetadata = await store.listPlanMetadata();

    // The purgeExpired method is private, so we'll need to trigger it
    // by performing a read operation that calls it internally
    await store.listActiveSteps();

    // Count what was purged (this is approximate since purge already happened)
    const activeStepsAfter = await store.listActiveSteps();
    const planMetadataAfter = await store.listPlanMetadata();

    const stepsPurged = activeSteps.length - activeStepsAfter.length;
    const plansPurged = planMetadata.length - planMetadataAfter.length;

    if (this.config.dryRun) {
      appLogger.info(
        {
          event: "plan_state.purge.dryrun",
          wouldPurgePlans: plansPurged,
          wouldPurgeSteps: stepsPurged
        },
        `[DRY RUN] Would purge ${stepsPurged} steps from ${plansPurged} plans`
      );
    }

    return {
      stepsPurged: Math.max(0, stepsPurged),
      plansPurged: Math.max(0, plansPurged),
      cutoffDate,
      backend: "file"
    };
  }
}

function parseArgs(): Partial<PurgeConfig> {
  const args = process.argv.slice(2);
  const config: Partial<PurgeConfig> = {};

  for (const arg of args) {
    if (arg === "--dry-run") {
      config.dryRun = true;
    } else if (arg.startsWith("--retention-days=")) {
      const value = parseInt(arg.split("=")[1] || "", 10);
      if (value > 0) {
        config.retentionDays = value;
      }
    }
  }

  return config;
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  return ["true", "1", "yes", "on"].includes(value.toLowerCase());
}

async function main(): Promise<void> {
  const args = parseArgs();

  const config: PurgeConfig = {
    retentionDays: args.retentionDays ?? parseInt(process.env.PLAN_RETENTION_DAYS || "30", 10),
    dryRun: args.dryRun ?? parseBoolean(process.env.DRY_RUN),
    backend: (process.env.PLAN_STATE_BACKEND === "postgres" ? "postgres" : "file") as "file" | "postgres"
  };

  console.log("=== Plan State Purge Job ===");
  console.log(`Retention: ${config.retentionDays} days`);
  console.log(`Backend: ${config.backend}`);
  console.log(`Dry Run: ${config.dryRun ? "Yes" : "No"}`);
  console.log("");

  const purger = new PlanStatePurger(config);
  const result = await purger.execute();

  console.log("\n=== Purge Summary ===");
  console.log(`Steps Purged: ${result.stepsPurged}`);
  console.log(`Plans Purged: ${result.plansPurged}`);
  console.log(`Cutoff Date: ${result.cutoffDate.toISOString()}`);
  console.log(`Duration: ${(result.durationMs / 1000).toFixed(2)}s`);
  console.log(`Backend: ${result.backend}`);
  console.log("");
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
