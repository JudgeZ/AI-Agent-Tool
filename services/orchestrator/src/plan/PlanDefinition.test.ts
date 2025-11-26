import { describe, it, expect } from "vitest";
import {
  validatePlanDefinition,
  validatePlanDefinitionCollection,
  PlanDefinitionSchema,
  PlanStepDefinitionSchema,
  WorkflowTypeSchema,
  DEFAULT_CAPABILITY_LABELS,
} from "./PlanDefinition.js";
import { NodeType } from "../agents/ExecutionGraph.js";

describe("PlanDefinition", () => {
  describe("WorkflowTypeSchema", () => {
    it("accepts valid workflow types", () => {
      const types = ["alerts", "analytics", "automation", "coding", "chat"];
      for (const type of types) {
        expect(WorkflowTypeSchema.parse(type)).toBe(type);
      }
    });

    it("rejects invalid workflow types", () => {
      expect(() => WorkflowTypeSchema.parse("invalid")).toThrow();
      expect(() => WorkflowTypeSchema.parse("")).toThrow();
      expect(() => WorkflowTypeSchema.parse(123)).toThrow();
    });
  });

  describe("PlanStepDefinitionSchema", () => {
    const validStep = {
      id: "step-1",
      action: "test_action",
      tool: "test_tool",
      capability: "repo.read",
    };

    it("accepts valid step with minimal fields", () => {
      const result = PlanStepDefinitionSchema.parse(validStep);
      expect(result.id).toBe("step-1");
      expect(result.action).toBe("test_action");
      expect(result.tool).toBe("test_tool");
      expect(result.capability).toBe("repo.read");
    });

    it("applies default values", () => {
      const result = PlanStepDefinitionSchema.parse(validStep);
      expect(result.labels).toEqual([]);
      expect(result.timeoutSeconds).toBe(300);
      expect(result.approvalRequired).toBe(false);
      expect(result.input).toEqual({});
      expect(result.dependencies).toEqual([]);
      expect(result.transitions).toEqual([]);
      expect(result.nodeType).toBe(NodeType.TASK);
      expect(result.continueOnError).toBe(false);
    });

    it("accepts step with all optional fields", () => {
      const fullStep = {
        ...validStep,
        capabilityLabel: "Read repository",
        labels: ["label1", "label2"],
        timeoutSeconds: 600,
        approvalRequired: true,
        input: { key: "value" },
        metadata: { meta: "data" },
        dependencies: ["dep-1"],
        transitions: [{ nextStepId: "step-2" }],
        nodeType: NodeType.CONDITION,
        retryPolicy: {
          maxRetries: 5,
          backoffMs: 2000,
          exponential: true,
        },
        continueOnError: true,
        description: "Test step description",
      };
      const result = PlanStepDefinitionSchema.parse(fullStep);
      expect(result.capabilityLabel).toBe("Read repository");
      expect(result.labels).toEqual(["label1", "label2"]);
      expect(result.retryPolicy?.maxRetries).toBe(5);
    });

    it("rejects step with missing required fields", () => {
      expect(() => PlanStepDefinitionSchema.parse({})).toThrow();
      expect(() =>
        PlanStepDefinitionSchema.parse({ id: "test" })
      ).toThrow();
    });

    it("rejects step with invalid timeout", () => {
      expect(() =>
        PlanStepDefinitionSchema.parse({
          ...validStep,
          timeoutSeconds: 0,
        })
      ).toThrow();
      expect(() =>
        PlanStepDefinitionSchema.parse({
          ...validStep,
          timeoutSeconds: 100000, // > 86400
        })
      ).toThrow();
    });
  });

  describe("PlanDefinitionSchema", () => {
    const minimalPlan = {
      id: "plan-1",
      name: "Test Plan",
      workflowType: "coding",
      steps: [
        {
          id: "step-1",
          action: "test",
          tool: "test_tool",
          capability: "repo.read",
        },
      ],
    };

    it("accepts valid plan with minimal fields", () => {
      const result = PlanDefinitionSchema.parse(minimalPlan);
      expect(result.id).toBe("plan-1");
      expect(result.name).toBe("Test Plan");
      expect(result.workflowType).toBe("coding");
      expect(result.steps).toHaveLength(1);
    });

    it("applies default values", () => {
      const result = PlanDefinitionSchema.parse(minimalPlan);
      expect(result.version).toBe("1.0.0");
      expect(result.inputConditions).toEqual([]);
      expect(result.variables).toEqual({});
      expect(result.successCriteria).toEqual([]);
      expect(result.tags).toEqual([]);
      expect(result.enabled).toBe(true);
    });

    it("rejects plan with no steps", () => {
      expect(() =>
        PlanDefinitionSchema.parse({
          id: "plan-1",
          name: "Test Plan",
          workflowType: "coding",
          steps: [],
        })
      ).toThrow();
    });

    it("rejects plan with invalid workflow type", () => {
      expect(() =>
        PlanDefinitionSchema.parse({
          ...minimalPlan,
          workflowType: "invalid",
        })
      ).toThrow();
    });
  });

  describe("validatePlanDefinition", () => {
    const validPlan = {
      id: "plan-1",
      name: "Test Plan",
      workflowType: "coding",
      steps: [
        {
          id: "step-1",
          action: "test",
          tool: "test_tool",
          capability: "repo.read",
        },
        {
          id: "step-2",
          action: "test2",
          tool: "test_tool2",
          capability: "repo.write",
          dependencies: ["step-1"],
        },
      ],
    };

    it("validates and returns a plan with auto-computed entry steps", () => {
      const result = validatePlanDefinition(validPlan);
      expect(result.entrySteps).toEqual(["step-1"]);
    });

    it("applies default capability labels", () => {
      const result = validatePlanDefinition(validPlan);
      expect(result.steps[0].capabilityLabel).toBe(
        DEFAULT_CAPABILITY_LABELS["repo.read"]
      );
      expect(result.steps[1].capabilityLabel).toBe(
        DEFAULT_CAPABILITY_LABELS["repo.write"]
      );
    });

    it("throws on non-existent dependency", () => {
      const invalidPlan = {
        ...validPlan,
        steps: [
          {
            id: "step-entry",
            action: "entry",
            tool: "entry_tool",
            capability: "repo.read",
          },
          {
            id: "step-1",
            action: "test",
            tool: "test_tool",
            capability: "repo.read",
            dependencies: ["non-existent"],
          },
        ],
      };
      expect(() => validatePlanDefinition(invalidPlan)).toThrow(
        'depends on non-existent step "non-existent"'
      );
    });

    it("throws on non-existent transition target", () => {
      const invalidPlan = {
        ...validPlan,
        steps: [
          {
            id: "step-1",
            action: "test",
            tool: "test_tool",
            capability: "repo.read",
            transitions: [{ nextStepId: "non-existent" }],
          },
        ],
      };
      expect(() => validatePlanDefinition(invalidPlan)).toThrow(
        'transition to non-existent step "non-existent"'
      );
    });

    it("throws when all steps have dependencies (no entry point)", () => {
      const circularPlan = {
        id: "plan-1",
        name: "Test Plan",
        workflowType: "coding",
        steps: [
          {
            id: "step-1",
            action: "test",
            tool: "test_tool",
            capability: "repo.read",
            dependencies: ["step-2"],
          },
          {
            id: "step-2",
            action: "test2",
            tool: "test_tool2",
            capability: "repo.write",
            dependencies: ["step-1"],
          },
        ],
      };
      expect(() => validatePlanDefinition(circularPlan)).toThrow(
        "has no entry steps"
      );
    });

    it("validates specified entry steps exist", () => {
      const planWithEntrySteps = {
        ...validPlan,
        entrySteps: ["non-existent"],
      };
      expect(() => validatePlanDefinition(planWithEntrySteps)).toThrow(
        'Entry step "non-existent" does not exist'
      );
    });

    it("detects cyclic dependencies", () => {
      const cyclicPlan = {
        id: "plan-1",
        name: "Cyclic Plan",
        workflowType: "coding",
        entrySteps: ["step-entry"],
        steps: [
          {
            id: "step-entry",
            action: "entry",
            tool: "entry_tool",
            capability: "repo.read",
          },
          {
            id: "step-a",
            action: "a",
            tool: "tool_a",
            capability: "repo.read",
            dependencies: ["step-entry", "step-c"], // A depends on C
          },
          {
            id: "step-b",
            action: "b",
            tool: "tool_b",
            capability: "repo.read",
            dependencies: ["step-a"], // B depends on A
          },
          {
            id: "step-c",
            action: "c",
            tool: "tool_c",
            capability: "repo.read",
            dependencies: ["step-b"], // C depends on B -> cycle: A->B->C->A
          },
        ],
      };
      expect(() => validatePlanDefinition(cyclicPlan)).toThrow(
        "contains cyclic dependencies"
      );
    });
  });

  describe("validatePlanDefinitionCollection", () => {
    const validCollection = {
      schemaVersion: "1.0.0",
      plans: [
        {
          id: "plan-1",
          name: "Plan 1",
          workflowType: "coding",
          steps: [
            {
              id: "step-1",
              action: "test",
              tool: "test_tool",
              capability: "repo.read",
            },
          ],
        },
        {
          id: "plan-2",
          name: "Plan 2",
          workflowType: "alerts",
          steps: [
            {
              id: "step-1",
              action: "test",
              tool: "test_tool",
              capability: "alert.read",
            },
          ],
        },
      ],
    };

    it("validates a collection of plans", () => {
      const result = validatePlanDefinitionCollection(validCollection);
      expect(result.plans).toHaveLength(2);
      expect(result.schemaVersion).toBe("1.0.0");
    });

    it("throws on duplicate plan IDs", () => {
      const duplicateCollection = {
        plans: [
          {
            id: "plan-1",
            name: "Plan 1",
            workflowType: "coding",
            steps: [
              {
                id: "step-1",
                action: "test",
                tool: "test_tool",
                capability: "repo.read",
              },
            ],
          },
          {
            id: "plan-1", // Duplicate ID
            name: "Plan 2",
            workflowType: "alerts",
            steps: [
              {
                id: "step-1",
                action: "test",
                tool: "test_tool",
                capability: "alert.read",
              },
            ],
          },
        ],
      };
      expect(() => validatePlanDefinitionCollection(duplicateCollection)).toThrow(
        "Duplicate plan ID: plan-1"
      );
    });
  });

  describe("DEFAULT_CAPABILITY_LABELS", () => {
    it("has labels for common capabilities", () => {
      expect(DEFAULT_CAPABILITY_LABELS["repo.read"]).toBe("Read repository");
      expect(DEFAULT_CAPABILITY_LABELS["repo.write"]).toBe(
        "Apply repository changes"
      );
      expect(DEFAULT_CAPABILITY_LABELS["test.run"]).toBe("Execute tests");
      expect(DEFAULT_CAPABILITY_LABELS["network.egress"]).toBe(
        "Call external service"
      );
    });
  });
});
