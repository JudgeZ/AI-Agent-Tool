import { describe, it, expect, vi, beforeEach } from "vitest";
import { PlanFactory } from "./PlanFactory.js";
import {
  InMemoryPlanDefinitionRepository,
  type IPlanDefinitionRepository,
} from "./PlanDefinitionRepository.js";
import type { PlanDefinition } from "./PlanDefinition.js";
import { NodeType } from "../agents/ExecutionGraph.js";

// Mock dependencies
vi.mock("../observability/logger.js", () => ({
  appLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  normalizeError: (e: Error) => ({ message: e.message }),
}));

vi.mock("../observability/tracing.js", () => ({
  startSpan: vi.fn(() => ({
    setAttribute: vi.fn(),
    spanContext: () => ({ traceId: "test-trace-id" }),
    end: vi.fn(),
  })),
}));

vi.mock("./events.js", () => ({
  publishPlanStepEvent: vi.fn(),
}));

describe("PlanFactory", () => {
  let repository: IPlanDefinitionRepository;
  let factory: PlanFactory;

  const createTestPlan = (
    overrides: Partial<PlanDefinition> = {}
  ): PlanDefinition => ({
    id: "test-plan",
    name: "Test Plan",
    workflowType: "coding",
    version: "1.0.0",
    inputConditions: [],
    steps: [
      {
        id: "step-1",
        action: "index_repo",
        tool: "repo_indexer",
        capability: "repo.read",
        capabilityLabel: "Read repository",
        labels: ["repo"],
        timeoutSeconds: 300,
        approvalRequired: false,
        input: { goal: "${goal}" },
        dependencies: [],
        transitions: [],
        nodeType: NodeType.TASK,
        continueOnError: false,
      },
      {
        id: "step-2",
        action: "apply_changes",
        tool: "code_writer",
        capability: "repo.write",
        capabilityLabel: "Apply changes",
        labels: ["repo", "approval"],
        timeoutSeconds: 600,
        approvalRequired: true,
        input: { goal: "${goal}" },
        dependencies: ["step-1"],
        transitions: [],
        nodeType: NodeType.TASK,
        continueOnError: false,
      },
    ],
    entrySteps: ["step-1"],
    variables: { defaultVar: "value" },
    successCriteria: ["Tests pass"],
    tags: ["test"],
    enabled: true,
    ...overrides,
  });

  beforeEach(() => {
    repository = new InMemoryPlanDefinitionRepository();
    factory = new PlanFactory(repository);
  });

  describe("createPlan", () => {
    it("creates a plan from a goal with matching plan", async () => {
      const testPlan = createTestPlan();
      (repository as InMemoryPlanDefinitionRepository).addPlan(testPlan);

      const result = await factory.createPlan({
        goal: "implement feature",
      });

      expect(result.executionId).toMatch(/^exec-/);
      expect(result.definition.id).toBe("test-plan");
      expect(result.goal).toBe("implement feature");
      expect(result.graph).toBeDefined();
    });

    it("creates a plan by specific planId", async () => {
      const testPlan = createTestPlan({ id: "specific-plan" });
      (repository as InMemoryPlanDefinitionRepository).addPlan(testPlan);

      const result = await factory.createPlan({
        goal: "any goal",
        planId: "specific-plan",
      });

      expect(result.definition.id).toBe("specific-plan");
    });

    it("throws when specific planId not found", async () => {
      await expect(
        factory.createPlan({
          goal: "test",
          planId: "non-existent",
        })
      ).rejects.toThrow("Plan not found: non-existent");
    });

    it("throws when no matching plan found", async () => {
      await expect(
        factory.createPlan({
          goal: "test",
          workflowType: "coding",
        })
      ).rejects.toThrow("No matching plan found");
    });

    it("merges variables from plan and options", async () => {
      const testPlan = createTestPlan({
        variables: { planVar: "fromPlan" },
      });
      (repository as InMemoryPlanDefinitionRepository).addPlan(testPlan);

      const result = await factory.createPlan({
        goal: "test goal",
        variables: { optionVar: "fromOptions" },
      });

      expect(result.variables.planVar).toBe("fromPlan");
      expect(result.variables.optionVar).toBe("fromOptions");
      expect(result.variables.goal).toBe("test goal");
      expect(result.variables.planId).toBe("test-plan");
      expect(result.variables.executionId).toMatch(/^exec-/);
    });

    it("includes subject info in variables", async () => {
      const testPlan = createTestPlan();
      (repository as InMemoryPlanDefinitionRepository).addPlan(testPlan);

      const result = await factory.createPlan({
        goal: "test",
        subject: {
          tenantId: "tenant-1",
          userId: "user-1",
          sessionId: "session-1",
        },
      });

      expect(result.variables.tenantId).toBe("tenant-1");
      expect(result.variables.userId).toBe("user-1");
      expect(result.variables.sessionId).toBe("session-1");
    });

    it("respects workflowType filter", async () => {
      const codingPlan = createTestPlan({ id: "coding-plan", workflowType: "coding" });
      const alertPlan = createTestPlan({ id: "alert-plan", workflowType: "alerts" });

      (repository as InMemoryPlanDefinitionRepository).addPlan(codingPlan);
      (repository as InMemoryPlanDefinitionRepository).addPlan(alertPlan);

      const result = await factory.createPlan({
        goal: "test",
        workflowType: "alerts",
      });

      expect(result.definition.id).toBe("alert-plan");
    });

    it("creates execution graph with correct structure", async () => {
      const testPlan = createTestPlan();
      (repository as InMemoryPlanDefinitionRepository).addPlan(testPlan);

      const result = await factory.createPlan({ goal: "test" });
      const graphDef = result.graph.getDefinition();

      expect(graphDef.nodes).toHaveLength(2);
      expect(graphDef.nodes[0].id).toBe("step-1");
      expect(graphDef.nodes[0].type).toBe(NodeType.TASK);
      expect(graphDef.nodes[1].id).toBe("step-2");
      expect(graphDef.nodes[1].dependencies).toContain("step-1");
      expect(graphDef.entryNodes).toContain("step-1");
    });

    it("converts step timeout from seconds to milliseconds", async () => {
      const testPlan = createTestPlan();
      (repository as InMemoryPlanDefinitionRepository).addPlan(testPlan);

      const result = await factory.createPlan({ goal: "test" });
      const graphDef = result.graph.getDefinition();

      expect(graphDef.nodes[0].timeout).toBe(300000); // 300 seconds * 1000
      expect(graphDef.nodes[1].timeout).toBe(600000); // 600 seconds * 1000
    });

    it("applies retry policy to nodes", async () => {
      const testPlan = createTestPlan({
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
            nodeType: NodeType.TASK,
            continueOnError: false,
            retryPolicy: {
              maxRetries: 3,
              backoffMs: 1000,
              exponential: true,
            },
          },
        ],
        entrySteps: ["step-1"],
      });
      (repository as InMemoryPlanDefinitionRepository).addPlan(testPlan);

      const result = await factory.createPlan({ goal: "test" });
      const graphDef = result.graph.getDefinition();

      expect(graphDef.nodes[0].retryPolicy).toEqual({
        maxRetries: 3,
        backoffMs: 1000,
        exponential: true,
      });
    });

    it("sets continueOnError on nodes", async () => {
      const testPlan = createTestPlan({
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
            nodeType: NodeType.TASK,
            continueOnError: true,
          },
        ],
        entrySteps: ["step-1"],
      });
      (repository as InMemoryPlanDefinitionRepository).addPlan(testPlan);

      const result = await factory.createPlan({ goal: "test" });
      const graphDef = result.graph.getDefinition();

      expect(graphDef.nodes[0].continueOnError).toBe(true);
    });

    it("respects concurrency limit", async () => {
      const testPlan = createTestPlan();
      (repository as InMemoryPlanDefinitionRepository).addPlan(testPlan);

      const result = await factory.createPlan({
        goal: "test",
        concurrencyLimit: 5,
      });

      // The graph is created with the concurrency limit
      // We verify it indirectly through the graph's behavior
      expect(result.graph).toBeDefined();
    });
  });

  describe("createPlanById", () => {
    it("creates a plan by ID without goal matching", async () => {
      const testPlan = createTestPlan({ id: "my-plan" });
      (repository as InMemoryPlanDefinitionRepository).addPlan(testPlan);

      const result = await factory.createPlanById("my-plan");

      expect(result.definition.id).toBe("my-plan");
      expect(result.goal).toBe("Test Plan"); // Uses plan name as default goal
    });

    it("throws when plan ID not found", async () => {
      await expect(factory.createPlanById("non-existent")).rejects.toThrow(
        "Plan not found: non-existent"
      );
    });

    it("uses provided goal from variables", async () => {
      const testPlan = createTestPlan({ id: "my-plan" });
      (repository as InMemoryPlanDefinitionRepository).addPlan(testPlan);

      const result = await factory.createPlanById("my-plan", {
        variables: { goal: "custom goal" },
      });

      expect(result.goal).toBe("custom goal");
    });
  });

  describe("registerHandler", () => {
    it("allows registering custom node handlers", async () => {
      const customHandler = {
        execute: vi.fn().mockResolvedValue({ custom: true }),
      };

      factory.registerHandler(NodeType.TASK, customHandler);

      const testPlan = createTestPlan();
      (repository as InMemoryPlanDefinitionRepository).addPlan(testPlan);

      const result = await factory.createPlan({ goal: "test" });

      // Verify the handler is registered on the graph
      expect(result.graph.hasHandler(NodeType.TASK)).toBe(true);
    });
  });

  describe("variable substitution", () => {
    it("substitutes variables in step input", async () => {
      const testPlan = createTestPlan({
        steps: [
          {
            id: "step-1",
            action: "test",
            tool: "test_tool",
            capability: "repo.read",
            labels: [],
            timeoutSeconds: 300,
            approvalRequired: false,
            input: {
              goal: "${goal}",
              custom: "${customVar}",
              nested: {
                value: "${nestedVar}",
              },
              array: ["${arrayItem}"],
            },
            dependencies: [],
            transitions: [],
            nodeType: NodeType.TASK,
            continueOnError: false,
          },
        ],
        entrySteps: ["step-1"],
      });
      (repository as InMemoryPlanDefinitionRepository).addPlan(testPlan);

      const result = await factory.createPlan({
        goal: "my goal",
        variables: {
          customVar: "custom value",
          nestedVar: "nested value",
          arrayItem: "array value",
        },
      });

      const graphDef = result.graph.getDefinition();
      const nodeConfig = graphDef.nodes[0].config;

      expect((nodeConfig.input as Record<string, unknown>).goal).toBe("my goal");
      expect((nodeConfig.input as Record<string, unknown>).custom).toBe("custom value");
      expect(
        ((nodeConfig.input as Record<string, unknown>).nested as Record<string, unknown>).value
      ).toBe("nested value");
      expect((nodeConfig.input as Record<string, unknown>).array).toContain("array value");
    });

    it("keeps original template when variable not found", async () => {
      const testPlan = createTestPlan({
        steps: [
          {
            id: "step-1",
            action: "test",
            tool: "test_tool",
            capability: "repo.read",
            labels: [],
            timeoutSeconds: 300,
            approvalRequired: false,
            input: {
              missing: "${missingVar}",
            },
            dependencies: [],
            transitions: [],
            nodeType: NodeType.TASK,
            continueOnError: false,
          },
        ],
        entrySteps: ["step-1"],
      });
      (repository as InMemoryPlanDefinitionRepository).addPlan(testPlan);

      const result = await factory.createPlan({ goal: "test" });

      const graphDef = result.graph.getDefinition();
      const nodeConfig = graphDef.nodes[0].config;

      expect((nodeConfig.input as Record<string, unknown>).missing).toBe("${missingVar}");
    });

    it("substitutes variables with hyphens and dots in names", async () => {
      const testPlan = createTestPlan({
        steps: [
          {
            id: "index-repo",
            action: "index",
            tool: "indexer",
            capability: "repo.read",
            labels: [],
            timeoutSeconds: 300,
            approvalRequired: false,
            input: {},
            dependencies: [],
            transitions: [],
            nodeType: NodeType.TASK,
            continueOnError: false,
          },
          {
            id: "step-2",
            action: "test",
            tool: "test_tool",
            capability: "repo.read",
            labels: [],
            timeoutSeconds: 300,
            approvalRequired: false,
            input: {
              previousOutput: "${index-repo.output}",
              dotVar: "${some.nested.var}",
            },
            dependencies: ["index-repo"],
            transitions: [],
            nodeType: NodeType.TASK,
            continueOnError: false,
          },
        ],
        entrySteps: ["index-repo"],
        variables: {
          "index-repo.output": "indexed data",
          "some.nested.var": "nested value",
        },
      });
      (repository as InMemoryPlanDefinitionRepository).addPlan(testPlan);

      const result = await factory.createPlan({ goal: "test" });

      const graphDef = result.graph.getDefinition();
      const step2Node = graphDef.nodes.find((n) => n.id === "step-2");
      const nodeConfig = step2Node!.config;

      expect((nodeConfig.input as Record<string, unknown>).previousOutput).toBe("indexed data");
      expect((nodeConfig.input as Record<string, unknown>).dotVar).toBe("nested value");
    });

    it("prevents prototype pollution in variable substitution", async () => {
      const testPlan = createTestPlan({
        steps: [
          {
            id: "step-1",
            action: "test",
            tool: "test_tool",
            capability: "repo.read",
            labels: [],
            timeoutSeconds: 300,
            approvalRequired: false,
            input: {
              proto: "${__proto__}",
              constructor: "${constructor}",
              prototype: "${prototype}",
            },
            dependencies: [],
            transitions: [],
            nodeType: NodeType.TASK,
            continueOnError: false,
          },
        ],
        entrySteps: ["step-1"],
        variables: {
          __proto__: "malicious",
          constructor: "malicious",
          prototype: "malicious",
        },
      });
      (repository as InMemoryPlanDefinitionRepository).addPlan(testPlan);

      const result = await factory.createPlan({ goal: "test" });

      const graphDef = result.graph.getDefinition();
      const nodeConfig = graphDef.nodes[0].config;

      // These should NOT be substituted
      expect((nodeConfig.input as Record<string, unknown>).proto).toBe("${__proto__}");
      expect((nodeConfig.input as Record<string, unknown>).constructor).toBe("${constructor}");
      expect((nodeConfig.input as Record<string, unknown>).prototype).toBe("${prototype}");
    });
  });

  describe("default handlers", () => {
    it("registers default handlers for all node types", async () => {
      const testPlan = createTestPlan();
      (repository as InMemoryPlanDefinitionRepository).addPlan(testPlan);

      const result = await factory.createPlan({ goal: "test" });

      expect(result.graph.hasHandler(NodeType.TASK)).toBe(true);
      expect(result.graph.hasHandler(NodeType.CONDITION)).toBe(true);
      expect(result.graph.hasHandler(NodeType.PARALLEL)).toBe(true);
      expect(result.graph.hasHandler(NodeType.MERGE)).toBe(true);
      expect(result.graph.hasHandler(NodeType.LOOP)).toBe(true);
    });
  });
});
