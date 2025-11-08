import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { Pool } from "pg";

import { PostgresPlanStateStore } from "./PlanStateStore.js";
import type { PlanStep } from "../plan/planner.js";

const sampleStep: PlanStep = {
  id: "s1",
  action: "index_repo",
  capability: "repo.read",
  capabilityLabel: "Read repository",
  labels: ["repo"],
  tool: "repo_indexer",
  timeoutSeconds: 120,
  approvalRequired: false,
  input: {},
  metadata: {},
};

const PLAN_ID = "plan-550e8400-e29b-41d4-a716-446655440000";
const APPROVAL_PLAN_ID = "plan-12345678-9abc-4def-8abc-1234567890ab";

describe("PostgresPlanStateStore", () => {
  let container: StartedTestContainer;
  let pool: Pool;
  let store: PostgresPlanStateStore;

  beforeAll(async () => {
    container = await new GenericContainer("postgres:15-alpine")
      .withEnvironment({
        POSTGRES_PASSWORD: "password",
        POSTGRES_USER: "user",
        POSTGRES_DB: "plans",
      })
      .withExposedPorts(5432)
      .start();

    const host = container.getHost();
    const port = container.getMappedPort(5432);
    const connectionString = `postgres://user:password@${host}:${port}/plans`;
    pool = new Pool({ connectionString });
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(() => {
    store = new PostgresPlanStateStore(pool);
  });

  afterEach(async () => {
    await store.clear();
  });

  it("persists queued steps and updates state", async () => {
    const createdAt = new Date().toISOString();
    await store.rememberStep(PLAN_ID, sampleStep, "trace-1", {
      idempotencyKey: "p1s1",
      attempt: 0,
      createdAt,
    });
    await store.setState(PLAN_ID, "s1", "running", "Dispatching", { diff: { files: [] } }, 0);

    const pending = await store.listActiveSteps();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.state).toBe("running");
    expect(pending[0]?.summary).toBe("Dispatching");
    expect(pending[0]?.output).toEqual({ diff: { files: [] } });
    expect(pending[0]?.attempt).toBe(0);
  });

  it("clears terminal states", async () => {
    const createdAt = new Date().toISOString();
    await store.rememberStep(PLAN_ID, sampleStep, "trace-1", {
      idempotencyKey: "terminal",
      attempt: 0,
      createdAt,
    });
    await store.setState(PLAN_ID, "s1", "completed", "Done");
    expect(await store.listActiveSteps()).toHaveLength(0);

    await store.rememberStep(PLAN_ID, sampleStep, "trace-1", {
      idempotencyKey: "terminal",
      attempt: 0,
      createdAt,
    });
    await store.setState(PLAN_ID, "s1", "dead_lettered", "Dropped");
    expect(await store.listActiveSteps()).toHaveLength(0);
  });

  it("forgets steps explicitly", async () => {
    await store.rememberStep(PLAN_ID, sampleStep, "trace-1", {
      idempotencyKey: "forget",
      attempt: 0,
      createdAt: new Date().toISOString(),
    });
    await store.forgetStep(PLAN_ID, "s1");
    expect(await store.listActiveSteps()).toHaveLength(0);
  });

  it("records approval metadata for a step", async () => {
    await store.rememberStep(
      APPROVAL_PLAN_ID,
      { ...sampleStep, approvalRequired: true },
      "trace-approval",
      {
        initialState: "waiting_approval",
        idempotencyKey: "approval",
        attempt: 0,
        createdAt: new Date().toISOString(),
      },
    );

    await store.recordApproval(APPROVAL_PLAN_ID, "s1", "repo.write", true);
    const entry = await store.getEntry(APPROVAL_PLAN_ID, "s1");
    expect(entry?.approvals).toEqual({ "repo.write": true });
  });

  it("purges entries that exceed the retention window", async () => {
    await store.clear();
    store = new PostgresPlanStateStore(pool, { retentionMs: 100 });
    await store.rememberStep(PLAN_ID, sampleStep, "trace-retain", {
      idempotencyKey: "retain",
      attempt: 0,
      createdAt: new Date().toISOString(),
    });

    await pool.query(
      `UPDATE plan_state SET updated_at = NOW() - INTERVAL '10 minutes' WHERE plan_id = $1 AND step_id = $2`,
      [PLAN_ID, "s1"],
    );

    expect(await store.listActiveSteps()).toHaveLength(0);
  });
});
