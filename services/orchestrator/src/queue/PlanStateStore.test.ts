import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PlanStateStore } from "./PlanStateStore.js";

const sampleStep = {
  id: "s1",
  action: "index_repo",
  capability: "repo.read",
  capabilityLabel: "Read repository",
  labels: ["repo"],
  tool: "repo_indexer",
  timeoutSeconds: 120,
  approvalRequired: false,
  input: {},
  metadata: {}
};

describe("PlanStateStore", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "plan-state-"));
    storePath = path.join(dir, "state.json");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("persists queued steps and updates state", async () => {
    const store = new PlanStateStore({ filePath: storePath });
    await store.rememberStep("plan-1", sampleStep, "trace-1", {
      idempotencyKey: "p1s1",
      attempt: 0,
      createdAt: new Date().toISOString()
    });
    await store.setState("plan-1", "s1", "running", "Dispatching", { diff: { files: [] } }, 0);

    const reloaded = new PlanStateStore({ filePath: storePath });
    const pending = await reloaded.listActiveSteps();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.state).toBe("running");
    expect(pending[0]?.summary).toBe("Dispatching");
    expect(pending[0]?.output).toEqual({ diff: { files: [] } });
    expect(pending[0]?.attempt).toBe(0);
  });

  it("clears terminal states", async () => {
    const store = new PlanStateStore({ filePath: storePath });
    await store.rememberStep("plan-1", sampleStep, "trace-1", {
      idempotencyKey: "pTs1",
      attempt: 0,
      createdAt: new Date().toISOString()
    });
    await store.setState("plan-1", "s1", "completed", "Done");
    const remaining = await store.listActiveSteps();
    expect(remaining).toHaveLength(0);

    await store.rememberStep("plan-1", sampleStep, "trace-1", {
      idempotencyKey: "pTs1",
      attempt: 0,
      createdAt: new Date().toISOString()
    });
    await store.setState("plan-1", "s1", "dead_lettered", "Dropped");
    const afterDead = await store.listActiveSteps();
    expect(afterDead).toHaveLength(0);
  });

  it("forgets steps explicitly", async () => {
    const store = new PlanStateStore({ filePath: storePath });
    await store.rememberStep("plan-1", sampleStep, "trace-1", {
      idempotencyKey: "pFs1",
      attempt: 0,
      createdAt: new Date().toISOString()
    });
    await store.forgetStep("plan-1", "s1");
    const pending = await store.listActiveSteps();
    expect(pending).toHaveLength(0);
  });

  it("remembers waiting approval state when provided", async () => {
    const store = new PlanStateStore({ filePath: storePath });
    await store.rememberStep(
      "plan-approval",
      { ...sampleStep, approvalRequired: true },
      "trace-approval",
      {
        initialState: "waiting_approval",
        idempotencyKey: "pAs1",
        attempt: 0,
        createdAt: new Date().toISOString()
      }
    );

    const pending = await store.listActiveSteps();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.state).toBe("waiting_approval");
    expect(pending[0]?.attempt).toBe(0);
  });

  it("records approval metadata for a step", async () => {
    const store = new PlanStateStore({ filePath: storePath });
    await store.rememberStep(
      "plan-approval",
      { ...sampleStep, approvalRequired: true },
      "trace-approval",
      {
        initialState: "waiting_approval",
        idempotencyKey: "pAs2",
        attempt: 0,
        createdAt: new Date().toISOString()
      }
    );

    await store.recordApproval("plan-approval", "s1", "repo.write", true);

    const entry = await store.getEntry("plan-approval", "s1");
    expect(entry?.approvals).toEqual({ "repo.write": true });
  });
});
