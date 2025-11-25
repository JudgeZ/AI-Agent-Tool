import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PipelineExecutor,
  PipelineFactory,
  PipelineType,
  PipelineConfig,
  PipelineContext,
  ConditionFailedError,
} from "./StandardPipelines";
import {
  NodeType,
  NodeDefinition,
  ExecutionContext,
} from "./ExecutionGraph";
import { MessageBus, SharedContextManager } from "./AgentCommunication";

// Mock the logger to avoid side effects in tests
vi.mock("../observability/logger", () => {
  const mockLogger: any = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => mockLogger),
  };
  return {
    appLogger: mockLogger,
    logger: mockLogger,
  };
});

// Create a mock ToolRegistry that doesn't require a real logger
class MockToolRegistry {
  private tools = new Map<string, unknown>();

  get(name: string): unknown {
    return this.tools.get(name);
  }

  register(name: string, tool: unknown): void {
    this.tools.set(name, tool);
  }
}

describe("StandardPipelines", () => {
  describe("PipelineExecutor expression evaluation", () => {
    let executor: PipelineExecutor;
    let mockContext: PipelineContext;

    beforeEach(() => {
      mockContext = {
        pipelineId: "test-pipeline",
        tenantId: "test-tenant",
        userId: "test-user",
        sessionId: "test-session",
        messageBus: {} as MessageBus,
        contextManager: {} as SharedContextManager,
        toolRegistry: new MockToolRegistry() as any,
        parameters: {},
      };
      executor = new PipelineExecutor(mockContext);
    });

    describe("evaluateCondition", () => {
      // Access private method for testing via any cast
      const evaluateCondition = (executor: PipelineExecutor, condition: string): boolean => {
        return (executor as any).evaluateCondition(condition);
      };

      it("should evaluate simple numeric comparisons", () => {
        expect(evaluateCondition(executor, "5 > 3")).toBe(true);
        expect(evaluateCondition(executor, "5 < 3")).toBe(false);
        expect(evaluateCondition(executor, "5 >= 5")).toBe(true);
        expect(evaluateCondition(executor, "5 <= 4")).toBe(false);
      });

      it("should evaluate strict equality", () => {
        expect(evaluateCondition(executor, "5 === 5")).toBe(true);
        expect(evaluateCondition(executor, "5 === 3")).toBe(false);
        expect(evaluateCondition(executor, "5 !== 3")).toBe(true);
        expect(evaluateCondition(executor, "5 !== 5")).toBe(false);
      });

      it("should evaluate boolean literals", () => {
        expect(evaluateCondition(executor, "true")).toBe(true);
        expect(evaluateCondition(executor, "false")).toBe(false);
        expect(evaluateCondition(executor, "true === true")).toBe(true);
        expect(evaluateCondition(executor, "true === false")).toBe(false);
      });

      it("should evaluate logical operators", () => {
        expect(evaluateCondition(executor, "true && true")).toBe(true);
        expect(evaluateCondition(executor, "true && false")).toBe(false);
        expect(evaluateCondition(executor, "true || false")).toBe(true);
        expect(evaluateCondition(executor, "false || false")).toBe(false);
      });

      it("should handle parentheses", () => {
        expect(evaluateCondition(executor, "(5 > 3)")).toBe(true);
        expect(evaluateCondition(executor, "(true && false) || true")).toBe(true);
        expect(evaluateCondition(executor, "true && (false || true)")).toBe(true);
      });

      it("should handle negative numbers", () => {
        expect(evaluateCondition(executor, "-5 < 0")).toBe(true);
        expect(evaluateCondition(executor, "5 > -3")).toBe(true);
        expect(evaluateCondition(executor, "-5 === -5")).toBe(true);
      });

      it("should handle decimal numbers", () => {
        expect(evaluateCondition(executor, "3.14 > 3")).toBe(true);
        expect(evaluateCondition(executor, "2.5 === 2.5")).toBe(true);
      });

      it("should reject invalid expressions gracefully", () => {
        // Invalid characters should return false
        expect(evaluateCondition(executor, "5 + 3")).toBe(false);
        expect(evaluateCondition(executor, "alert(1)")).toBe(false);
        expect(evaluateCondition(executor, "constructor")).toBe(false);
      });

      it("should prevent code injection attempts", () => {
        // These should all return false and not execute anything
        expect(evaluateCondition(executor, "constructor.constructor('return this')()")).toBe(false);
        expect(evaluateCondition(executor, "process.exit(1)")).toBe(false);
        expect(evaluateCondition(executor, "require('fs')")).toBe(false);
        expect(evaluateCondition(executor, "__proto__")).toBe(false);
      });
    });

    describe("substituteVariables", () => {
      const substituteVariables = (
        executor: PipelineExecutor,
        template: string,
        context: ExecutionContext,
      ): string => {
        return (executor as any).substituteVariables(template, context);
      };

      it("should substitute simple variable references", () => {
        const context: ExecutionContext = {
          graphId: "test",
          executionId: "exec-1",
          variables: new Map(),
          outputs: new Map([["node1", { value: "hello" }]]),
          metadata: {},
        };

        expect(substituteVariables(executor, "${node1.value}", context)).toBe("hello");
      });

      it("should substitute nested field references", () => {
        const context: ExecutionContext = {
          graphId: "test",
          executionId: "exec-1",
          variables: new Map(),
          outputs: new Map([["node1", { nested: { deep: "value" } }]]),
          metadata: {},
        };

        expect(substituteVariables(executor, "${node1.nested.deep}", context)).toBe("value");
      });

      it("should keep original reference if node not found", () => {
        const context: ExecutionContext = {
          graphId: "test",
          executionId: "exec-1",
          variables: new Map(),
          outputs: new Map(),
          metadata: {},
        };

        expect(substituteVariables(executor, "${unknown.value}", context)).toBe("${unknown.value}");
      });

      it("should serialize objects as JSON", () => {
        const context: ExecutionContext = {
          graphId: "test",
          executionId: "exec-1",
          variables: new Map(),
          outputs: new Map([["node1", { data: { a: 1, b: 2 } }]]),
          metadata: {},
        };

        expect(substituteVariables(executor, "${node1.data}", context)).toBe('{"a":1,"b":2}');
      });

      it("should serialize arrays as JSON", () => {
        const context: ExecutionContext = {
          graphId: "test",
          executionId: "exec-1",
          variables: new Map(),
          outputs: new Map([["node1", { items: [1, 2, 3] }]]),
          metadata: {},
        };

        expect(substituteVariables(executor, "${node1.items}", context)).toBe("[1,2,3]");
      });

      it("should handle null values", () => {
        const context: ExecutionContext = {
          graphId: "test",
          executionId: "exec-1",
          variables: new Map(),
          outputs: new Map([["node1", { value: null }]]),
          metadata: {},
        };

        expect(substituteVariables(executor, "${node1.value}", context)).toBe("null");
      });

      it("should handle entire node output without field path", () => {
        const context: ExecutionContext = {
          graphId: "test",
          executionId: "exec-1",
          variables: new Map(),
          outputs: new Map([["node1", "simple-value"]]),
          metadata: {},
        };

        expect(substituteVariables(executor, "${node1}", context)).toBe("simple-value");
      });

      it("should block prototype pollution via __proto__", () => {
        const context: ExecutionContext = {
          graphId: "test",
          executionId: "exec-1",
          variables: new Map(),
          outputs: new Map([["node1", { value: "safe" }]]),
          metadata: {},
        };

        // Should keep original reference unchanged when dangerous property accessed
        expect(substituteVariables(executor, "${node1.__proto__}", context)).toBe("${node1.__proto__}");
        // Normal properties should still work
        expect(substituteVariables(executor, "${node1.value}", context)).toBe("safe");
      });

      it("should block prototype pollution via constructor", () => {
        const context: ExecutionContext = {
          graphId: "test",
          executionId: "exec-1",
          variables: new Map(),
          outputs: new Map([["node1", { data: "test" }]]),
          metadata: {},
        };

        expect(substituteVariables(executor, "${node1.constructor}", context)).toBe("${node1.constructor}");
        expect(substituteVariables(executor, "${node1.constructor.prototype}", context)).toBe(
          "${node1.constructor.prototype}",
        );
      });

      it("should block prototype pollution via prototype", () => {
        const context: ExecutionContext = {
          graphId: "test",
          executionId: "exec-1",
          variables: new Map(),
          outputs: new Map([["node1", { info: "value" }]]),
          metadata: {},
        };

        expect(substituteVariables(executor, "${node1.prototype}", context)).toBe("${node1.prototype}");
      });
    });

    describe("serializeValue", () => {
      const serializeValue = (executor: PipelineExecutor, value: unknown): string => {
        return (executor as any).serializeValue(value);
      };

      it("should serialize primitives correctly", () => {
        expect(serializeValue(executor, "hello")).toBe("hello");
        expect(serializeValue(executor, 42)).toBe("42");
        expect(serializeValue(executor, true)).toBe("true");
        expect(serializeValue(executor, false)).toBe("false");
      });

      it("should serialize null and undefined", () => {
        expect(serializeValue(executor, null)).toBe("null");
        expect(serializeValue(executor, undefined)).toBe("undefined");
      });

      it("should serialize objects as JSON", () => {
        expect(serializeValue(executor, { a: 1 })).toBe('{"a":1}');
        expect(serializeValue(executor, [1, 2, 3])).toBe("[1,2,3]");
      });
    });
  });

  describe("PipelineFactory", () => {
    it("should create development pipeline", () => {
      const config: PipelineConfig = {
        type: PipelineType.DEVELOPMENT,
        name: "Test Dev Pipeline",
        description: "A test pipeline",
        parameters: { requirements: "Build a feature" },
      };

      const context: PipelineContext = {
        pipelineId: "test",
        tenantId: "tenant",
        userId: "user",
        sessionId: "session",
        messageBus: {} as MessageBus,
        contextManager: {} as SharedContextManager,
        toolRegistry: new MockToolRegistry() as any,
        parameters: {},
      };

      const graph = PipelineFactory.create(config, context);

      expect(graph.name).toBe("Test Dev Pipeline");
      expect(graph.nodes.length).toBeGreaterThan(0);
      expect(graph.entryNodes).toContain("analyze-requirements");
    });

    it("should create quick fix pipeline", () => {
      const config: PipelineConfig = {
        type: PipelineType.QUICK_FIX,
        name: "Test Quick Fix",
        description: "Fix a bug",
        parameters: { error: "TypeError" },
      };

      const context: PipelineContext = {
        pipelineId: "test",
        tenantId: "tenant",
        userId: "user",
        sessionId: "session",
        messageBus: {} as MessageBus,
        contextManager: {} as SharedContextManager,
        toolRegistry: new MockToolRegistry() as any,
        parameters: {},
      };

      const graph = PipelineFactory.create(config, context);

      expect(graph.name).toBe("Test Quick Fix");
      expect(graph.entryNodes).toContain("analyze-issue");
    });

    it("should return all supported pipeline types", () => {
      const types = PipelineFactory.getSupportedTypes();

      expect(types).toContain(PipelineType.DEVELOPMENT);
      expect(types).toContain(PipelineType.QUICK_FIX);
      expect(types).toContain(PipelineType.REFACTORING);
      expect(types).toContain(PipelineType.CODE_REVIEW);
      expect(types).toContain(PipelineType.TESTING);
    });

    it("should throw for unsupported pipeline type", () => {
      const config = {
        type: "unsupported" as PipelineType,
        name: "Test",
        description: "Test",
        parameters: {},
      };

      const context: PipelineContext = {
        pipelineId: "test",
        tenantId: "tenant",
        userId: "user",
        sessionId: "session",
        messageBus: {} as MessageBus,
        contextManager: {} as SharedContextManager,
        toolRegistry: new MockToolRegistry() as any,
        parameters: {},
      };

      expect(() => PipelineFactory.create(config, context)).toThrow("Unsupported pipeline type");
    });
  });

  describe("Handler creation", () => {
    let executor: PipelineExecutor;
    let mockContext: PipelineContext;

    beforeEach(() => {
      mockContext = {
        pipelineId: "test-pipeline",
        tenantId: "test-tenant",
        userId: "test-user",
        sessionId: "test-session",
        messageBus: {} as MessageBus,
        contextManager: {} as SharedContextManager,
        toolRegistry: new MockToolRegistry() as any,
        parameters: {},
      };
      executor = new PipelineExecutor(mockContext);
    });

    it("should create condition handler that passes when expression is true", async () => {
      const handler = (executor as any).createConditionHandler();
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map([["prev", { passed: 5, total: 5 }]]),
        metadata: {},
      };

      const node: NodeDefinition = {
        id: "condition-1",
        type: NodeType.CONDITION,
        name: "Test Condition",
        dependencies: ["prev"],
        config: {
          condition: "5 === 5",
        },
      };

      const result = await handler.execute(node, context);

      expect(result).toMatchObject({
        status: "passed",
        condition: "5 === 5",
        result: true,
        passed: true,
      });
    });

    it("should create condition handler that throws ConditionFailedError with proper structure", async () => {
      const handler = (executor as any).createConditionHandler();
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map(),
        metadata: {},
      };

      const node: NodeDefinition = {
        id: "condition-1",
        type: NodeType.CONDITION,
        name: "Test Condition",
        dependencies: [],
        config: {
          condition: "5 === 3",
        },
      };

      try {
        await handler.execute(node, context);
        expect.fail("Should have thrown ConditionFailedError");
      } catch (error) {
        // Verify error type
        expect(error).toBeInstanceOf(ConditionFailedError);

        // Verify error structure
        const conditionError = error as ConditionFailedError;
        expect(conditionError.name).toBe("ConditionFailedError");
        expect(conditionError.message).toContain("Condition failed");

        // Verify conditionResult field
        expect(conditionError.conditionResult).toBeDefined();
        expect(conditionError.conditionResult.condition).toBe("5 === 3");
        expect(conditionError.conditionResult.evaluatedCondition).toBe("5 === 3");
        expect(conditionError.conditionResult.result).toBe(false);
        expect(conditionError.conditionResult.passed).toBe(false);
      }
    });

    it("should handle boolean variable reference in condition (true)", async () => {
      const handler = (executor as any).createConditionHandler();
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map([["prev", { passed: true }]]),
        metadata: {},
      };

      const node: NodeDefinition = {
        id: "bool-condition",
        type: NodeType.CONDITION,
        name: "Boolean Condition",
        dependencies: ["prev"],
        config: {
          condition: "${prev.passed}",
        },
      };

      const result = await handler.execute(node, context);

      expect(result).toMatchObject({
        status: "passed",
        result: true,
        passed: true,
      });
    });

    it("should handle boolean variable reference in condition (false)", async () => {
      const handler = (executor as any).createConditionHandler();
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map([["prev", { passed: false }]]),
        metadata: {},
      };

      const node: NodeDefinition = {
        id: "bool-condition",
        type: NodeType.CONDITION,
        name: "Boolean Condition",
        dependencies: ["prev"],
        config: {
          condition: "${prev.passed}",
        },
      };

      await expect(handler.execute(node, context)).rejects.toThrow("Condition failed");
    });

    it("should handle numeric variable reference in condition", async () => {
      const handler = (executor as any).createConditionHandler();
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map([["prev", { count: 5 }]]),
        metadata: {},
      };

      const node: NodeDefinition = {
        id: "num-condition",
        type: NodeType.CONDITION,
        name: "Numeric Condition",
        dependencies: ["prev"],
        config: {
          condition: "${prev.count}",
        },
      };

      // 5 is truthy
      const result = await handler.execute(node, context);
      expect(result).toMatchObject({ status: "passed", result: true });
    });

    it("should handle zero numeric reference as falsy", async () => {
      const handler = (executor as any).createConditionHandler();
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map([["prev", { count: 0 }]]),
        metadata: {},
      };

      const node: NodeDefinition = {
        id: "zero-condition",
        type: NodeType.CONDITION,
        name: "Zero Condition",
        dependencies: ["prev"],
        config: {
          condition: "${prev.count}",
        },
      };

      // 0 is falsy
      await expect(handler.execute(node, context)).rejects.toThrow("Condition failed");
    });

    it("should create merge handler that collects outputs", async () => {
      const handler = (executor as any).createMergeHandler();
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map([
          ["node1", { value: "result1" }],
          ["node2", { value: "result2", findings: [{ issue: "test" }] }],
        ]),
        metadata: {},
      };

      const node: NodeDefinition = {
        id: "merge-1",
        type: NodeType.MERGE,
        name: "Merge Results",
        dependencies: ["node1", "node2"],
        config: {},
      };

      const result = await handler.execute(node, context);

      expect(result).toMatchObject({
        status: "completed",
        mergedCount: 2,
      });
      expect((result as any).mergedResults.node1).toEqual({ value: "result1" });
      expect((result as any).findings).toHaveLength(1);
    });

    it("should create loop handler with max iterations safety", async () => {
      const handler = (executor as any).createLoopHandler();
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map(),
        metadata: {},
      };

      const node: NodeDefinition = {
        id: "loop-1",
        type: NodeType.LOOP,
        name: "Test Loop",
        dependencies: [],
        config: {
          maxIterations: 3,
          condition: "false", // Exit immediately
        },
      };

      const result = await handler.execute(node, context);

      expect(result).toMatchObject({
        status: "completed",
        iterations: 0,
      });
    });

    it("should iterate over items array with _item context", async () => {
      const handler = (executor as any).createLoopHandler();
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map([["source", { data: ["a", "b", "c"] }]]),
        metadata: {},
      };

      // Mock executeGenericTool to capture _item values
      const capturedItems: unknown[] = [];
      (executor as any).executeGenericTool = vi.fn().mockImplementation((node: NodeDefinition) => {
        capturedItems.push(node.config._item);
        return Promise.resolve({ processed: node.config._item });
      });

      const node: NodeDefinition = {
        id: "loop-items",
        type: NodeType.LOOP,
        name: "Item Loop",
        dependencies: ["source"],
        config: {
          items: "${source.data}",
          operation: "process",
        },
      };

      const result = await handler.execute(node, context);

      expect(result).toMatchObject({
        status: "completed",
        iterations: 3,
      });
      expect(capturedItems).toEqual(["a", "b", "c"]);
      expect((result as any).results).toHaveLength(3);
    });

    it("should enforce maxIterations limit", async () => {
      const handler = (executor as any).createLoopHandler();
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map(),
        metadata: {},
      };

      let iterationCount = 0;
      (executor as any).executeGenericTool = vi.fn().mockImplementation(() => {
        iterationCount++;
        return Promise.resolve({ count: iterationCount });
      });

      const node: NodeDefinition = {
        id: "loop-max",
        type: NodeType.LOOP,
        name: "Max Iterations Loop",
        dependencies: [],
        config: {
          maxIterations: 5,
          condition: "true", // Always true - only maxIterations should stop it
          operation: "increment",
        },
      };

      const result = await handler.execute(node, context);

      expect(result).toMatchObject({
        status: "completed",
        iterations: 5,
      });
      expect(iterationCount).toBe(5);
    });

    it("should clean up temporary iteration keys after completion", async () => {
      const handler = (executor as any).createLoopHandler();
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map([["source", { items: [1, 2] }]]),
        metadata: {},
      };

      (executor as any).executeGenericTool = vi.fn().mockResolvedValue({ done: true });

      const node: NodeDefinition = {
        id: "cleanup-loop",
        type: NodeType.LOOP,
        name: "Cleanup Test",
        dependencies: ["source"],
        config: {
          items: "${source.items}",
          operation: "work",
        },
      };

      await handler.execute(node, context);

      // Verify namespaced iteration keys are cleaned up
      expect(context.outputs.has("__loop:cleanup-loop:iteration:0")).toBe(false);
      expect(context.outputs.has("__loop:cleanup-loop:iteration:1")).toBe(false);
    });

    it("should use namespaced keys to avoid collision with user node IDs", async () => {
      const handler = (executor as any).createLoopHandler();
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map([
          ["source", { items: [1] }],
          // Simulate a user node with a potentially colliding ID
          ["myloop_iteration_0", { userValue: "should not be affected" }],
        ]),
        metadata: {},
      };

      (executor as any).executeGenericTool = vi.fn().mockResolvedValue({ done: true });

      const node: NodeDefinition = {
        id: "myloop",
        type: NodeType.LOOP,
        name: "Collision Test",
        dependencies: ["source"],
        config: {
          items: "${source.items}",
          operation: "work",
        },
      };

      await handler.execute(node, context);

      // User's node should still be intact (old format would have collided)
      expect(context.outputs.get("myloop_iteration_0")).toEqual({ userValue: "should not be affected" });
    });

    it("should store iteration outputs with namespaced keys during execution", async () => {
      const handler = (executor as any).createLoopHandler();
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map([["source", { items: ["x", "y"] }]]),
        metadata: {},
      };

      // Track what keys are set during execution
      const keysSetDuringExecution: string[] = [];
      const originalSet = context.outputs.set.bind(context.outputs);
      context.outputs.set = (key: string, value: unknown) => {
        keysSetDuringExecution.push(key);
        return originalSet(key, value);
      };

      (executor as any).executeGenericTool = vi.fn().mockResolvedValue({ done: true });

      const node: NodeDefinition = {
        id: "track-loop",
        type: NodeType.LOOP,
        name: "Key Tracking Loop",
        dependencies: ["source"],
        config: {
          items: "${source.items}",
          operation: "work",
        },
      };

      await handler.execute(node, context);

      // Verify namespaced keys were used during execution
      expect(keysSetDuringExecution).toContain("__loop:track-loop:iteration:0");
      expect(keysSetDuringExecution).toContain("__loop:track-loop:iteration:1");
      // But they should be cleaned up after
      expect(context.outputs.has("__loop:track-loop:iteration:0")).toBe(false);
    });

    it("should create parallel handler that returns node info", async () => {
      const handler = (executor as any).createParallelHandler();
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map(),
        metadata: {},
      };

      const node: NodeDefinition = {
        id: "parallel-1",
        type: NodeType.PARALLEL,
        name: "Parallel Tasks",
        description: "Run tasks in parallel",
        dependencies: ["task1", "task2"],
        config: {},
      };

      const result = await handler.execute(node, context);

      expect(result).toMatchObject({
        status: "completed",
        nodeId: "parallel-1",
        parallelBranches: ["task1", "task2"],
      });
    });
  });

  describe("resolveNodeConfig", () => {
    let executor: PipelineExecutor;

    beforeEach(() => {
      const mockContext: PipelineContext = {
        pipelineId: "test-pipeline",
        tenantId: "test-tenant",
        userId: "test-user",
        sessionId: "test-session",
        messageBus: {} as MessageBus,
        contextManager: {} as SharedContextManager,
        toolRegistry: new MockToolRegistry() as any,
        parameters: {},
      };
      executor = new PipelineExecutor(mockContext);
    });

    it("should resolve variable references in node config", () => {
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map([["prev", { query: "search term" }]]),
        metadata: {},
      };

      const node: NodeDefinition = {
        id: "test-node",
        type: NodeType.TASK,
        name: "Test",
        dependencies: ["prev"],
        config: {
          operation: "search",
          query: "${prev.query}",
          limit: 10,
        },
      };

      const resolved = (executor as any).resolveNodeConfig(node, context);

      expect(resolved.config.query).toBe("search term");
      expect(resolved.config.limit).toBe(10);
      expect(resolved.config.operation).toBe("search");
    });

    it("should preserve array types for pure variable references", () => {
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map([["prev", { items: [1, 2, 3, 4, 5] }]]),
        metadata: {},
      };

      const node: NodeDefinition = {
        id: "test-node",
        type: NodeType.LOOP,
        name: "Test Loop",
        dependencies: ["prev"],
        config: {
          items: "${prev.items}",
        },
      };

      const resolved = (executor as any).resolveNodeConfig(node, context);

      // Should preserve the array type, not convert to "[1,2,3,4,5]" string
      expect(Array.isArray(resolved.config.items)).toBe(true);
      expect(resolved.config.items).toEqual([1, 2, 3, 4, 5]);
    });

    it("should preserve object types for pure variable references", () => {
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map([["prev", { data: { name: "test", count: 42 } }]]),
        metadata: {},
      };

      const node: NodeDefinition = {
        id: "test-node",
        type: NodeType.TASK,
        name: "Test",
        dependencies: ["prev"],
        config: {
          payload: "${prev.data}",
        },
      };

      const resolved = (executor as any).resolveNodeConfig(node, context);

      // Should preserve the object type
      expect(typeof resolved.config.payload).toBe("object");
      expect(resolved.config.payload).toEqual({ name: "test", count: 42 });
    });

    it("should serialize to string for template strings with embedded references", () => {
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map([["prev", { items: [1, 2, 3] }]]),
        metadata: {},
      };

      const node: NodeDefinition = {
        id: "test-node",
        type: NodeType.TASK,
        name: "Test",
        dependencies: ["prev"],
        config: {
          message: "Processing items: ${prev.items}",
        },
      };

      const resolved = (executor as any).resolveNodeConfig(node, context);

      // Template string should serialize the array to JSON
      expect(typeof resolved.config.message).toBe("string");
      expect(resolved.config.message).toBe("Processing items: [1,2,3]");
    });

    it("should keep original string if pure reference cannot be resolved", () => {
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map(),
        metadata: {},
      };

      const node: NodeDefinition = {
        id: "test-node",
        type: NodeType.TASK,
        name: "Test",
        dependencies: [],
        config: {
          items: "${unknown.items}",
        },
      };

      const resolved = (executor as any).resolveNodeConfig(node, context);

      // Should keep original string if reference not found
      expect(resolved.config.items).toBe("${unknown.items}");
    });

    it("should resolve variables in deeply nested config objects", () => {
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map([
          ["source", { apiKey: "secret-key", endpoint: "https://api.example.com" }],
        ]),
        metadata: {},
      };

      const node: NodeDefinition = {
        id: "test-node",
        type: NodeType.TASK,
        name: "Test",
        dependencies: ["source"],
        config: {
          context: {
            level1: {
              level2: {
                apiKey: "${source.apiKey}",
                url: "${source.endpoint}/v1/data",
              },
            },
          },
        },
      };

      const resolved = (executor as any).resolveNodeConfig(node, context);

      // Verify deeply nested resolution
      expect(resolved.config.context.level1.level2.apiKey).toBe("secret-key");
      expect(resolved.config.context.level1.level2.url).toBe("https://api.example.com/v1/data");
    });

    it("should resolve variables in arrays within nested objects", () => {
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map([["source", { host1: "server1.com", host2: "server2.com" }]]),
        metadata: {},
      };

      const node: NodeDefinition = {
        id: "test-node",
        type: NodeType.TASK,
        name: "Test",
        dependencies: ["source"],
        config: {
          servers: {
            primary: ["${source.host1}", "${source.host2}"],
            settings: {
              hosts: ["${source.host1}"],
            },
          },
        },
      };

      const resolved = (executor as any).resolveNodeConfig(node, context);

      expect(resolved.config.servers.primary).toEqual(["server1.com", "server2.com"]);
      expect(resolved.config.servers.settings.hosts).toEqual(["server1.com"]);
    });

    it("should resolve multi-level property chains from source", () => {
      const context: ExecutionContext = {
        graphId: "test",
        executionId: "exec-1",
        variables: new Map(),
        outputs: new Map([
          [
            "analysis",
            {
              results: {
                findings: {
                  critical: ["issue1", "issue2"],
                  metadata: { count: 2 },
                },
              },
            },
          ],
        ]),
        metadata: {},
      };

      const node: NodeDefinition = {
        id: "test-node",
        type: NodeType.TASK,
        name: "Test",
        dependencies: ["analysis"],
        config: {
          criticalIssues: "${analysis.results.findings.critical}",
          issueCount: "${analysis.results.findings.metadata.count}",
        },
      };

      const resolved = (executor as any).resolveNodeConfig(node, context);

      // Pure reference preserves array type
      expect(resolved.config.criticalIssues).toEqual(["issue1", "issue2"]);
      // Pure reference preserves number type
      expect(resolved.config.issueCount).toBe(2);
    });
  });
});
