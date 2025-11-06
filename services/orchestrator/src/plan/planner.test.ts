import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearPlanHistory, getPlanHistory } from "./events.js";
import {
  createPlan,
  flushPlanArtifactCleanup,
  resetPlanArtifactCleanupSchedulerForTests
} from "./planner.js";
import { parsePlan } from "./validation.js";

describe("planner", () => {
  const plansDir = path.join(process.cwd(), ".plans");

  beforeEach(() => {
    clearPlanHistory();
    fs.rmSync(plansDir, { recursive: true, force: true });
    resetPlanArtifactCleanupSchedulerForTests();
  });

  afterEach(() => {
    clearPlanHistory();
    fs.rmSync(plansDir, { recursive: true, force: true });
    resetPlanArtifactCleanupSchedulerForTests();
  });

  it("creates a validated plan with enriched metadata", async () => {
    const plan = await createPlan("Ship feature X");
    expect(plan.steps).not.toHaveLength(0);
    expect(() => parsePlan(plan)).not.toThrow();

    for (const step of plan.steps) {
      expect(step.tool).toBeTruthy();
      expect(step.capabilityLabel).toBeTruthy();
      expect(typeof step.timeoutSeconds).toBe("number");
    }

    const planPath = path.join(plansDir, plan.id, "plan.json");
    expect(fs.existsSync(planPath)).toBe(true);

    const events = getPlanHistory(plan.id);
    expect(events).toHaveLength(plan.steps.length);
    expect(events[0]?.step.capabilityLabel).toBe(plan.steps[0]?.capabilityLabel);
    expect(events.every(event => Boolean(event.occurredAt))).toBe(true);
  });

  it("purges plan artifacts older than the retention window", async () => {
    const oldPlanDir = path.join(plansDir, "plan-old");
    fs.mkdirSync(oldPlanDir, { recursive: true });
    const oldPlanFile = path.join(oldPlanDir, "plan.json");
    fs.writeFileSync(oldPlanFile, JSON.stringify({ id: "plan-old" }));
    const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldPlanDir, oldTime, oldTime);
    fs.utimesSync(oldPlanFile, oldTime, oldTime);

    const plan = await createPlan("Retention test", { retentionDays: 30 });

    await flushPlanArtifactCleanup();

    expect(fs.existsSync(oldPlanDir)).toBe(false);
    expect(fs.existsSync(path.join(plansDir, plan.id))).toBe(true);
  });

  it("cleans up expired artifacts via the background scheduler", async () => {
    const oldPlanDir = path.join(plansDir, "plan-background-old");
    fs.mkdirSync(oldPlanDir, { recursive: true });
    const oldPlanFile = path.join(oldPlanDir, "plan.json");
    fs.writeFileSync(oldPlanFile, JSON.stringify({ id: "plan-background-old" }));

    const oldTime = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldPlanDir, oldTime, oldTime);
    fs.utimesSync(oldPlanFile, oldTime, oldTime);

    await createPlan("Background cleanup", { retentionDays: 30 });

    await new Promise(resolve => setTimeout(resolve, 25));

    expect(fs.existsSync(oldPlanDir)).toBe(false);
  });

  it("skips suspicious directory names when cleaning up old plans", async () => {
    const suspiciousDir = path.join(plansDir, "plan..sneaky");
    fs.mkdirSync(suspiciousDir, { recursive: true });
    const suspiciousPlanFile = path.join(suspiciousDir, "plan.json");
    fs.writeFileSync(suspiciousPlanFile, JSON.stringify({ id: "plan..sneaky" }));

    const safeDir = path.join(plansDir, "plan-safe-old");
    fs.mkdirSync(safeDir, { recursive: true });
    const safePlanFile = path.join(safeDir, "plan.json");
    fs.writeFileSync(safePlanFile, JSON.stringify({ id: "plan-safe-old" }));

    const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    for (const candidate of [suspiciousDir, suspiciousPlanFile, safeDir, safePlanFile]) {
      fs.utimesSync(candidate, oldTime, oldTime);
    }

    const plan = await createPlan("Suspicious cleanup", { retentionDays: 30 });

    await flushPlanArtifactCleanup();

    expect(fs.existsSync(safeDir)).toBe(false);
    expect(fs.existsSync(suspiciousDir)).toBe(true);
    expect(fs.existsSync(path.join(plansDir, plan.id))).toBe(true);
  });

  it("does not follow symlinks outside the plans directory during cleanup", async () => {
    const outsideDir = path.join(process.cwd(), "outside-plan-artifacts");
    fs.rmSync(outsideDir, { recursive: true, force: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    fs.rmSync(plansDir, { recursive: true, force: true });
    fs.mkdirSync(plansDir, { recursive: true });

    const symlinkPath = path.join(plansDir, "linked-old-plan");
    fs.symlinkSync(outsideDir, symlinkPath, "dir");

    const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(outsideDir, oldTime, oldTime);
    fs.utimesSync(symlinkPath, oldTime, oldTime);

    const plan = await createPlan("Symlink safety", { retentionDays: 30 });

    await flushPlanArtifactCleanup();

    expect(fs.existsSync(outsideDir)).toBe(true);
    expect(fs.existsSync(symlinkPath)).toBe(true);
    expect(fs.existsSync(path.join(plansDir, plan.id))).toBe(true);

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("retains recent plan artifacts within the retention window", async () => {
    const recentDir = path.join(plansDir, "plan-recent");
    fs.mkdirSync(recentDir, { recursive: true });
    const recentFile = path.join(recentDir, "plan.json");
    fs.writeFileSync(recentFile, JSON.stringify({ id: "plan-recent" }));

    const almostOldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(recentDir, almostOldTime, almostOldTime);
    fs.utimesSync(recentFile, almostOldTime, almostOldTime);

    await createPlan("Retention boundary", { retentionDays: 30 });

    await flushPlanArtifactCleanup();

    expect(fs.existsSync(recentDir)).toBe(true);
    expect(fs.existsSync(recentFile)).toBe(true);
  });

  it("honors disabled retention policies", async () => {
    const oldPlanDir = path.join(plansDir, "plan-disabled-retention");
    fs.mkdirSync(oldPlanDir, { recursive: true });
    const oldPlanFile = path.join(oldPlanDir, "plan.json");
    fs.writeFileSync(oldPlanFile, JSON.stringify({ id: "plan-disabled-retention" }));

    const oldTime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldPlanDir, oldTime, oldTime);
    fs.utimesSync(oldPlanFile, oldTime, oldTime);

    await createPlan("Retention disabled", { retentionDays: 0 });

    await new Promise(resolve => setTimeout(resolve, 25));

    expect(fs.existsSync(oldPlanDir)).toBe(true);
  });

  it("creates multiple plans concurrently without blocking the event loop", async () => {
    const goals = Array.from({ length: 5 }, (_, index) => `Concurrent goal ${index}`);

    const timerPromise = new Promise<number>(resolve => {
      const started = Date.now();
      setTimeout(() => resolve(Date.now() - started), 25);
    });

    const plansPromise = Promise.all(goals.map(goal => createPlan(goal)));

    const [elapsed, plans] = await Promise.all([timerPromise, plansPromise]);

    expect(plans).toHaveLength(goals.length);
    expect(plans.every(plan => Boolean(plan.id))).toBe(true);
    expect(elapsed).toBeLessThan(200);
  });
});
