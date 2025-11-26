import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  YamlPlanDefinitionRepository,
  InMemoryPlanDefinitionRepository,
} from "./PlanDefinitionRepository.js";
import type { PlanDefinition } from "./PlanDefinition.js";

// Mock the logger to avoid console output during tests
vi.mock("../observability/logger.js", () => ({
  appLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  normalizeError: (e: Error) => ({ message: e.message }),
}));

describe("InMemoryPlanDefinitionRepository", () => {
  const createTestPlan = (id: string, workflowType: string): PlanDefinition => ({
    id,
    name: `Test Plan ${id}`,
    workflowType: workflowType as PlanDefinition["workflowType"],
    version: "1.0.0",
    inputConditions: [],
    steps: [
      {
        id: "step-1",
        action: "test",
        tool: "test_tool",
        capability: "repo.read",
        labels: [],
        timeoutSeconds: 300,
        approvalRequired: false,
        input: {},
        dependencies: [],
        transitions: [],
        nodeType: "task" as const,
        continueOnError: false,
      },
    ],
    variables: {},
    successCriteria: [],
    tags: [],
    enabled: true,
  });

  it("stores and retrieves plans", async () => {
    const repo = new InMemoryPlanDefinitionRepository();
    const plan = createTestPlan("plan-1", "coding");

    repo.addPlan(plan);
    const retrieved = await repo.getPlan("plan-1");

    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe("plan-1");
    expect(retrieved?.name).toBe("Test Plan plan-1");
  });

  it("returns undefined for non-existent plan", async () => {
    const repo = new InMemoryPlanDefinitionRepository();
    const retrieved = await repo.getPlan("non-existent");
    expect(retrieved).toBeUndefined();
  });

  it("removes plans", async () => {
    const repo = new InMemoryPlanDefinitionRepository();
    const plan = createTestPlan("plan-1", "coding");

    repo.addPlan(plan);
    expect(await repo.getPlan("plan-1")).toBeDefined();

    const removed = repo.removePlan("plan-1");
    expect(removed).toBe(true);
    expect(await repo.getPlan("plan-1")).toBeUndefined();
  });

  it("returns all plans", async () => {
    const repo = new InMemoryPlanDefinitionRepository();
    repo.addPlan(createTestPlan("plan-1", "coding"));
    repo.addPlan(createTestPlan("plan-2", "alerts"));

    const allPlans = await repo.getAllPlans();
    expect(allPlans).toHaveLength(2);
  });

  it("filters plans by workflow type", async () => {
    const repo = new InMemoryPlanDefinitionRepository();
    repo.addPlan(createTestPlan("plan-1", "coding"));
    repo.addPlan(createTestPlan("plan-2", "coding"));
    repo.addPlan(createTestPlan("plan-3", "alerts"));

    const codingPlans = await repo.getPlansByWorkflowType("coding");
    expect(codingPlans).toHaveLength(2);

    const alertPlans = await repo.getPlansByWorkflowType("alerts");
    expect(alertPlans).toHaveLength(1);
  });

  it("finds matching plans (returns all enabled when no conditions)", async () => {
    const repo = new InMemoryPlanDefinitionRepository();
    repo.addPlan(createTestPlan("plan-1", "coding"));
    repo.addPlan(createTestPlan("plan-2", "coding"));

    const matches = await repo.findMatchingPlans("implement feature");
    expect(matches).toHaveLength(2);
  });

  it("accepts initial plans in constructor", async () => {
    const initialPlans = [
      createTestPlan("plan-1", "coding"),
      createTestPlan("plan-2", "alerts"),
    ];
    const repo = new InMemoryPlanDefinitionRepository(initialPlans);

    const allPlans = await repo.getAllPlans();
    expect(allPlans).toHaveLength(2);
    expect(repo.getLastReloadTime()).toBeDefined();
  });
});

describe("YamlPlanDefinitionRepository", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "plan-repo-test-")
    );
  });

  afterEach(async () => {
    try {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  const writePlanYaml = async (
    filename: string,
    content: string
  ): Promise<void> => {
    await fsPromises.writeFile(path.join(tempDir, filename), content, "utf-8");
  };

  it("loads plans from YAML files", async () => {
    await writePlanYaml(
      "test.yaml",
      `
id: test-plan
name: Test Plan
workflowType: coding
steps:
  - id: step-1
    action: test
    tool: test_tool
    capability: repo.read
`
    );

    const repo = new YamlPlanDefinitionRepository({
      plansDirectory: tempDir,
    });
    await repo.initialize();

    const plan = await repo.getPlan("test-plan");
    expect(plan).toBeDefined();
    expect(plan?.name).toBe("Test Plan");
    expect(plan?.workflowType).toBe("coding");
  });

  it("loads plan collections from YAML", async () => {
    await writePlanYaml(
      "collection.yaml",
      `
schemaVersion: "1.0.0"
plans:
  - id: plan-1
    name: Plan 1
    workflowType: coding
    steps:
      - id: step-1
        action: test
        tool: test_tool
        capability: repo.read
  - id: plan-2
    name: Plan 2
    workflowType: alerts
    steps:
      - id: step-1
        action: test
        tool: test_tool
        capability: alert.read
`
    );

    const repo = new YamlPlanDefinitionRepository({
      plansDirectory: tempDir,
    });
    await repo.initialize();

    const allPlans = await repo.getAllPlans();
    expect(allPlans).toHaveLength(2);
  });

  it("handles missing directory gracefully", async () => {
    const nonExistentDir = path.join(tempDir, "non-existent");
    const repo = new YamlPlanDefinitionRepository({
      plansDirectory: nonExistentDir,
    });

    await repo.initialize();

    const allPlans = await repo.getAllPlans();
    expect(allPlans).toHaveLength(0);

    // Directory should be created
    const exists = await fsPromises
      .access(nonExistentDir, fs.constants.R_OK)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it("handles invalid YAML gracefully", async () => {
    await writePlanYaml("invalid.yaml", "this is not valid yaml: [");

    const repo = new YamlPlanDefinitionRepository({
      plansDirectory: tempDir,
    });

    // Should not throw, just log error
    await repo.initialize();

    const allPlans = await repo.getAllPlans();
    expect(allPlans).toHaveLength(0);
  });

  it("reloads plans on demand", async () => {
    await writePlanYaml(
      "test.yaml",
      `
id: test-plan
name: Original Name
workflowType: coding
steps:
  - id: step-1
    action: test
    tool: test_tool
    capability: repo.read
`
    );

    const repo = new YamlPlanDefinitionRepository({
      plansDirectory: tempDir,
    });
    await repo.initialize();

    let plan = await repo.getPlan("test-plan");
    expect(plan?.name).toBe("Original Name");

    // Update the file
    await writePlanYaml(
      "test.yaml",
      `
id: test-plan
name: Updated Name
workflowType: coding
steps:
  - id: step-1
    action: test
    tool: test_tool
    capability: repo.read
`
    );

    await repo.reload();

    plan = await repo.getPlan("test-plan");
    expect(plan?.name).toBe("Updated Name");
  });

  it("finds matching plans by workflow type", async () => {
    await writePlanYaml(
      "plans.yaml",
      `
schemaVersion: "1.0.0"
plans:
  - id: coding-plan
    name: Coding Plan
    workflowType: coding
    steps:
      - id: step-1
        action: test
        tool: test_tool
        capability: repo.read
  - id: alert-plan
    name: Alert Plan
    workflowType: alerts
    steps:
      - id: step-1
        action: test
        tool: test_tool
        capability: alert.read
`
    );

    const repo = new YamlPlanDefinitionRepository({
      plansDirectory: tempDir,
    });
    await repo.initialize();

    const codingMatches = await repo.findMatchingPlans("implement feature", "coding");
    expect(codingMatches).toHaveLength(1);
    expect(codingMatches[0].id).toBe("coding-plan");
  });

  it("matches plans by input conditions (keywords)", async () => {
    await writePlanYaml(
      "plans.yaml",
      `
schemaVersion: "1.0.0"
plans:
  - id: fix-plan
    name: Fix Plan
    workflowType: coding
    inputConditions:
      - type: keywords
        value: fix,bug,patch
        priority: 10
    steps:
      - id: step-1
        action: test
        tool: test_tool
        capability: repo.read
  - id: feature-plan
    name: Feature Plan
    workflowType: coding
    inputConditions:
      - type: keywords
        value: implement,add,create
        priority: 5
    steps:
      - id: step-1
        action: test
        tool: test_tool
        capability: repo.read
`
    );

    const repo = new YamlPlanDefinitionRepository({
      plansDirectory: tempDir,
    });
    await repo.initialize();

    const fixMatches = await repo.findMatchingPlans("fix the bug in auth");
    expect(fixMatches[0].id).toBe("fix-plan");

    const featureMatches = await repo.findMatchingPlans("implement new feature");
    expect(featureMatches[0].id).toBe("feature-plan");
  });

  it("matches plans by input conditions (pattern)", async () => {
    await writePlanYaml(
      "plans.yaml",
      `
schemaVersion: "1.0.0"
plans:
  - id: refactor-plan
    name: Refactor Plan
    workflowType: coding
    inputConditions:
      - type: pattern
        value: "^refactor\\\\s+"
        priority: 15
    steps:
      - id: step-1
        action: test
        tool: test_tool
        capability: repo.read
`
    );

    const repo = new YamlPlanDefinitionRepository({
      plansDirectory: tempDir,
    });
    await repo.initialize();

    const matches = await repo.findMatchingPlans("refactor the auth module");
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe("refactor-plan");

    const noMatches = await repo.findMatchingPlans("should not match refactor");
    expect(noMatches).toHaveLength(0);
  });

  it("excludes disabled plans from matches", async () => {
    await writePlanYaml(
      "plans.yaml",
      `
schemaVersion: "1.0.0"
plans:
  - id: enabled-plan
    name: Enabled Plan
    workflowType: coding
    enabled: true
    steps:
      - id: step-1
        action: test
        tool: test_tool
        capability: repo.read
  - id: disabled-plan
    name: Disabled Plan
    workflowType: coding
    enabled: false
    steps:
      - id: step-1
        action: test
        tool: test_tool
        capability: repo.read
`
    );

    const repo = new YamlPlanDefinitionRepository({
      plansDirectory: tempDir,
    });
    await repo.initialize();

    const allPlans = await repo.getAllPlans();
    expect(allPlans).toHaveLength(2);

    const matches = await repo.findMatchingPlans("test");
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe("enabled-plan");
  });

  it("returns last reload time", async () => {
    const repo = new YamlPlanDefinitionRepository({
      plansDirectory: tempDir,
    });

    expect(repo.getLastReloadTime()).toBeUndefined();

    await repo.initialize();

    expect(repo.getLastReloadTime()).toBeDefined();
    expect(repo.getLastReloadTime()).toBeInstanceOf(Date);
  });

  it("cleans up resources on close", async () => {
    const repo = new YamlPlanDefinitionRepository({
      plansDirectory: tempDir,
      watchForChanges: true,
    });
    await repo.initialize();

    // Should not throw
    await repo.close();
  });

  it("loads plans from subdirectories", async () => {
    const subDir = path.join(tempDir, "subdir");
    await fsPromises.mkdir(subDir, { recursive: true });

    await fsPromises.writeFile(
      path.join(subDir, "nested.yaml"),
      `
id: nested-plan
name: Nested Plan
workflowType: coding
steps:
  - id: step-1
    action: test
    tool: test_tool
    capability: repo.read
`,
      "utf-8"
    );

    const repo = new YamlPlanDefinitionRepository({
      plansDirectory: tempDir,
    });
    await repo.initialize();

    const plan = await repo.getPlan("nested-plan");
    expect(plan).toBeDefined();
    expect(plan?.name).toBe("Nested Plan");
  });
});
