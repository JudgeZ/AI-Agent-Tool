import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearPlanHistory, getPlanHistory } from "./events.js";
import { createPlan } from "./planner.js";
import { parsePlan } from "./validation.js";

describe("planner", () => {
  const plansDir = path.join(process.cwd(), ".plans");

  beforeEach(() => {
    clearPlanHistory();
    fs.rmSync(plansDir, { recursive: true, force: true });
  });

  afterEach(() => {
    clearPlanHistory();
    fs.rmSync(plansDir, { recursive: true, force: true });
  });

  it("creates a validated plan with enriched metadata", () => {
    const plan = createPlan("Ship feature X");
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

  it("purges plan artifacts older than the retention window", () => {
    const oldPlanDir = path.join(plansDir, "plan-old");
    fs.mkdirSync(oldPlanDir, { recursive: true });
    const oldPlanFile = path.join(oldPlanDir, "plan.json");
    fs.writeFileSync(oldPlanFile, JSON.stringify({ id: "plan-old" }));
    const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldPlanDir, oldTime, oldTime);
    fs.utimesSync(oldPlanFile, oldTime, oldTime);

    const plan = createPlan("Retention test", { retentionDays: 30 });

    expect(fs.existsSync(oldPlanDir)).toBe(false);
    expect(fs.existsSync(path.join(plansDir, plan.id))).toBe(true);
  });

  it("does not follow symlinks outside the plans directory during cleanup", () => {
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

    const plan = createPlan("Symlink safety", { retentionDays: 30 });

    expect(fs.existsSync(outsideDir)).toBe(true);
    expect(fs.existsSync(symlinkPath)).toBe(true);
    expect(fs.existsSync(path.join(plansDir, plan.id))).toBe(true);

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
});
