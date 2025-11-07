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

const PLAN_ID = "plan-550e8400-e29b-41d4-a716-446655440000";
const APPROVAL_PLAN_ID = "plan-12345678-9abc-4def-8abc-1234567890ab";
const RETAIN_PLAN_ID = "plan-00112233-4455-4677-8899-aabbccddeeff";

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
    await store.rememberStep(PLAN_ID, sampleStep, "trace-1", {
      idempotencyKey: "p1s1",
      attempt: 0,
      createdAt: new Date().toISOString()
    });
    await store.setState(PLAN_ID, "s1", "running", "Dispatching", { diff: { files: [] } }, 0);

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
    await store.rememberStep(PLAN_ID, sampleStep, "trace-1", {
      idempotencyKey: "pTs1",
      attempt: 0,
      createdAt: new Date().toISOString()
    });
    await store.setState(PLAN_ID, "s1", "completed", "Done");
    const remaining = await store.listActiveSteps();
    expect(remaining).toHaveLength(0);

    await store.rememberStep(PLAN_ID, sampleStep, "trace-1", {
      idempotencyKey: "pTs1",
      attempt: 0,
      createdAt: new Date().toISOString()
    });
    await store.setState(PLAN_ID, "s1", "dead_lettered", "Dropped");
    const afterDead = await store.listActiveSteps();
    expect(afterDead).toHaveLength(0);
  });

  it("forgets steps explicitly", async () => {
    const store = new PlanStateStore({ filePath: storePath });
    await store.rememberStep(PLAN_ID, sampleStep, "trace-1", {
      idempotencyKey: "pFs1",
      attempt: 0,
      createdAt: new Date().toISOString()
    });
    await store.forgetStep(PLAN_ID, "s1");
    const pending = await store.listActiveSteps();
    expect(pending).toHaveLength(0);
  });

  it("remembers waiting approval state when provided", async () => {
    const store = new PlanStateStore({ filePath: storePath });
    await store.rememberStep(
      APPROVAL_PLAN_ID,
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
      APPROVAL_PLAN_ID,
      { ...sampleStep, approvalRequired: true },
      "trace-approval",
      {
        initialState: "waiting_approval",
        idempotencyKey: "pAs2",
        attempt: 0,
        createdAt: new Date().toISOString()
      }
    );

    await store.recordApproval(APPROVAL_PLAN_ID, "s1", "repo.write", true);

    const entry = await store.getEntry(APPROVAL_PLAN_ID, "s1");
    expect(entry?.approvals).toEqual({ "repo.write": true });
  });

  it("purges entries that exceed the retention window", async () => {
    const store = new PlanStateStore({ filePath: storePath, retentionMs: 100 });
    const oldTimestamp = new Date(Date.now() - 10_000).toISOString();
    await store.rememberStep(RETAIN_PLAN_ID, sampleStep, "trace-retain", {
      idempotencyKey: "retain-1",
      attempt: 0,
      createdAt: oldTimestamp
    });

    const raw = await fs.readFile(storePath, "utf-8");
    const document = JSON.parse(raw) as { steps: Array<{ updatedAt: string }> };
    if (document.steps[0]) {
      document.steps[0].updatedAt = oldTimestamp;
    }
    await fs.writeFile(storePath, JSON.stringify(document));

    const reloaded = new PlanStateStore({ filePath: storePath, retentionMs: 100 });
    const pending = await reloaded.listActiveSteps();
    expect(pending).toHaveLength(0);
  });
});
