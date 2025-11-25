import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ExecutionGraph,
  GraphDefinition,
  NodeType,
  NodeHandler,
  NodeDefinition,
  ExecutionContext,
  NodeStatus,
} from "./ExecutionGraph";

describe("ExecutionGraph", () => {
  let simpleTaskHandler: NodeHandler;

  beforeEach(() => {
    simpleTaskHandler = {
      execute: vi.fn().mockResolvedValue({ result: "success" }),
    };
  });

  describe("graph validation", () => {
    it("should validate a simple linear graph", () => {
      const definition: GraphDefinition = {
        id: "test-graph",
        name: "Test Graph",
        nodes: [
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1",
            dependencies: [],
            config: {},
          },
          {
            id: "node2",
            type: NodeType.TASK,
            name: "Node 2",
            dependencies: ["node1"],
            config: {},
          },
        ],
        entryNodes: ["node1"],
      };

      expect(() => new ExecutionGraph(definition)).not.toThrow();
    });

    it("should reject graph with duplicate node IDs", () => {
      const definition: GraphDefinition = {
        id: "test-graph",
        name: "Test Graph",
        nodes: [
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1",
            dependencies: [],
            config: {},
          },
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1 Duplicate",
            dependencies: [],
            config: {},
          },
        ],
        entryNodes: ["node1"],
      };

      expect(() => new ExecutionGraph(definition)).toThrow("Duplicate node ID");
    });

    it("should reject graph with non-existent dependency", () => {
      const definition: GraphDefinition = {
        id: "test-graph",
        name: "Test Graph",
        nodes: [
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1",
            dependencies: ["nonexistent"],
            config: {},
          },
        ],
        entryNodes: ["node1"],
      };

      expect(() => new ExecutionGraph(definition)).toThrow("non-existent node");
    });

    it("should detect cycles in graph", () => {
      const definition: GraphDefinition = {
        id: "test-graph",
        name: "Test Graph",
        nodes: [
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1",
            dependencies: ["node2"],
            config: {},
          },
          {
            id: "node2",
            type: NodeType.TASK,
            name: "Node 2",
            dependencies: ["node1"],
            config: {},
          },
        ],
        entryNodes: [],
      };

      expect(() => new ExecutionGraph(definition)).toThrow("Cycle detected");
    });

    it("should auto-detect entry nodes", () => {
      const definition: GraphDefinition = {
        id: "test-graph",
        name: "Test Graph",
        nodes: [
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1",
            dependencies: [],
            config: {},
          },
          {
            id: "node2",
            type: NodeType.TASK,
            name: "Node 2",
            dependencies: ["node1"],
            config: {},
          },
        ],
        entryNodes: [],
      };

      const graph = new ExecutionGraph(definition);
      expect(graph.getDefinition().entryNodes).toEqual(["node1"]);
    });
  });

  describe("simple execution", () => {
    it("should execute single node graph", async () => {
      const definition: GraphDefinition = {
        id: "single-node",
        name: "Single Node",
        nodes: [
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1",
            dependencies: [],
            config: {},
          },
        ],
        entryNodes: ["node1"],
      };

      const graph = new ExecutionGraph(definition);
      graph.registerHandler(NodeType.TASK, simpleTaskHandler);

      const result = await graph.execute();

      expect(result.success).toBe(true);
      expect(result.completed).toBe(1);
      expect(result.failed).toBe(0);
      expect(simpleTaskHandler.execute).toHaveBeenCalledTimes(1);
    });

    it("should execute linear graph in order", async () => {
      const executionOrder: string[] = [];
      const orderedHandler: NodeHandler = {
        execute: vi.fn((node) => {
          executionOrder.push(node.id);
          return Promise.resolve({ result: "success" });
        }),
      };

      const definition: GraphDefinition = {
        id: "linear-graph",
        name: "Linear Graph",
        nodes: [
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1",
            dependencies: [],
            config: {},
          },
          {
            id: "node2",
            type: NodeType.TASK,
            name: "Node 2",
            dependencies: ["node1"],
            config: {},
          },
          {
            id: "node3",
            type: NodeType.TASK,
            name: "Node 3",
            dependencies: ["node2"],
            config: {},
          },
        ],
        entryNodes: ["node1"],
      };

      const graph = new ExecutionGraph(definition);
      graph.registerHandler(NodeType.TASK, orderedHandler);

      const result = await graph.execute();

      expect(result.success).toBe(true);
      expect(executionOrder).toEqual(["node1", "node2", "node3"]);
    });

    it("should execute parallel branches concurrently", async () => {
      const startTimes: Record<string, number> = {};
      const parallelHandler: NodeHandler = {
        execute: vi.fn(async (node) => {
          startTimes[node.id] = Date.now();
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { result: "success" };
        }),
      };

      const definition: GraphDefinition = {
        id: "parallel-graph",
        name: "Parallel Graph",
        nodes: [
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1",
            dependencies: [],
            config: {},
          },
          {
            id: "node2",
            type: NodeType.TASK,
            name: "Node 2",
            dependencies: ["node1"],
            config: {},
          },
          {
            id: "node3",
            type: NodeType.TASK,
            name: "Node 3",
            dependencies: ["node1"],
            config: {},
          },
          {
            id: "node4",
            type: NodeType.TASK,
            name: "Node 4",
            dependencies: ["node2", "node3"],
            config: {},
          },
        ],
        entryNodes: ["node1"],
      };

      const graph = new ExecutionGraph(definition, 10);
      graph.registerHandler(NodeType.TASK, parallelHandler);

      const result = await graph.execute();

      expect(result.success).toBe(true);
      expect(result.completed).toBe(4);

      // node2 and node3 should start at roughly the same time
      const timeDiff = Math.abs(startTimes["node2"] - startTimes["node3"]);
      expect(timeDiff).toBeLessThan(50); // Within 50ms
    });
  });

  describe("error handling", () => {
    it("should handle node failure", async () => {
      const failingHandler: NodeHandler = {
        execute: vi.fn().mockRejectedValue(new Error("Task failed")),
      };

      const definition: GraphDefinition = {
        id: "failing-graph",
        name: "Failing Graph",
        nodes: [
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1",
            dependencies: [],
            config: {},
          },
        ],
        entryNodes: ["node1"],
      };

      const graph = new ExecutionGraph(definition);
      graph.registerHandler(NodeType.TASK, failingHandler);

      await expect(graph.execute()).rejects.toThrow();

      const execution = graph.getExecution("node1");
      expect(execution?.status).toBe(NodeStatus.FAILED);
      expect(execution?.error?.message).toBe("Task failed");
    });

    it("should block dependent nodes on failure", async () => {
      const handlers = new Map<string, NodeHandler>();
      handlers.set("node1", {
        execute: vi.fn().mockRejectedValue(new Error("Node 1 failed")),
      });
      handlers.set("node2", {
        execute: vi.fn().mockResolvedValue({ result: "success" }),
      });

      const multiHandler: NodeHandler = {
        execute: (node, context) =>
          handlers.get(node.id)!.execute(node, context),
      };

      const definition: GraphDefinition = {
        id: "blocking-graph",
        name: "Blocking Graph",
        nodes: [
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1",
            dependencies: [],
            config: {},
          },
          {
            id: "node2",
            type: NodeType.TASK,
            name: "Node 2",
            dependencies: ["node1"],
            config: {},
          },
        ],
        entryNodes: ["node1"],
      };

      const graph = new ExecutionGraph(definition);
      graph.registerHandler(NodeType.TASK, multiHandler);

      await expect(graph.execute()).rejects.toThrow();

      const exec1 = graph.getExecution("node1");
      const exec2 = graph.getExecution("node2");

      expect(exec1?.status).toBe(NodeStatus.FAILED);
      expect(exec2?.status).toBe(NodeStatus.BLOCKED);
      expect(handlers.get("node2")!.execute).not.toHaveBeenCalled();
    });

    it("should continue on error when configured", async () => {
      const handlers = new Map<string, NodeHandler>();
      handlers.set("node1", {
        execute: vi.fn().mockRejectedValue(new Error("Node 1 failed")),
      });
      handlers.set("node2", {
        execute: vi.fn().mockResolvedValue({ result: "success" }),
      });

      const multiHandler: NodeHandler = {
        execute: (node, context) =>
          handlers.get(node.id)!.execute(node, context),
      };

      const definition: GraphDefinition = {
        id: "continue-on-error-graph",
        name: "Continue on Error Graph",
        nodes: [
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1",
            dependencies: [],
            config: {},
            continueOnError: true,
          },
          {
            id: "node2",
            type: NodeType.TASK,
            name: "Node 2",
            dependencies: ["node1"],
            config: {},
          },
        ],
        entryNodes: ["node1"],
      };

      const graph = new ExecutionGraph(definition);
      graph.registerHandler(NodeType.TASK, multiHandler);

      const result = await graph.execute();

      const exec1 = graph.getExecution("node1");
      const exec2 = graph.getExecution("node2");

      expect(exec1?.status).toBe(NodeStatus.FAILED);
      expect(exec2?.status).toBe(NodeStatus.COMPLETED);
      expect(handlers.get("node2")!.execute).toHaveBeenCalled();
    });
  });

  describe("retry policy", () => {
    it("should retry failed node", async () => {
      let attempts = 0;
      const retryHandler: NodeHandler = {
        execute: vi.fn().mockImplementation(() => {
          attempts++;
          if (attempts < 3) {
            return Promise.reject(new Error("Temporary failure"));
          }
          return Promise.resolve({ result: "success" });
        }),
      };

      const definition: GraphDefinition = {
        id: "retry-graph",
        name: "Retry Graph",
        nodes: [
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1",
            dependencies: [],
            config: {},
            retryPolicy: {
              maxRetries: 3,
              backoffMs: 10,
              exponential: false,
            },
          },
        ],
        entryNodes: ["node1"],
      };

      const graph = new ExecutionGraph(definition);
      graph.registerHandler(NodeType.TASK, retryHandler);

      const result = await graph.execute();

      expect(result.success).toBe(true);
      expect(attempts).toBe(3);
      expect(retryHandler.execute).toHaveBeenCalledTimes(3);
    });

    it("should use exponential backoff", async () => {
      const callTimes: number[] = [];
      let attempts = 0;

      const retryHandler: NodeHandler = {
        execute: vi.fn().mockImplementation(() => {
          callTimes.push(Date.now());
          attempts++;
          if (attempts < 3) {
            return Promise.reject(new Error("Temporary failure"));
          }
          return Promise.resolve({ result: "success" });
        }),
      };

      const definition: GraphDefinition = {
        id: "exponential-backoff-graph",
        name: "Exponential Backoff Graph",
        nodes: [
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1",
            dependencies: [],
            config: {},
            retryPolicy: {
              maxRetries: 3,
              backoffMs: 100,
              exponential: true,
            },
          },
        ],
        entryNodes: ["node1"],
      };

      const graph = new ExecutionGraph(definition);
      graph.registerHandler(NodeType.TASK, retryHandler);

      await graph.execute();

      // Check that delays increase exponentially
      const delay1 = callTimes[1] - callTimes[0];
      const delay2 = callTimes[2] - callTimes[1];

      expect(delay1).toBeGreaterThanOrEqual(100);
      expect(delay2).toBeGreaterThanOrEqual(200);
    });

    it("should fail after max retries", async () => {
      const retryHandler: NodeHandler = {
        execute: vi.fn().mockRejectedValue(new Error("Persistent failure")),
      };

      const definition: GraphDefinition = {
        id: "max-retries-graph",
        name: "Max Retries Graph",
        nodes: [
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1",
            dependencies: [],
            config: {},
            retryPolicy: {
              maxRetries: 2,
              backoffMs: 10,
              exponential: false,
            },
          },
        ],
        entryNodes: ["node1"],
      };

      const graph = new ExecutionGraph(definition);
      graph.registerHandler(NodeType.TASK, retryHandler);

      await expect(graph.execute()).rejects.toThrow();

      expect(retryHandler.execute).toHaveBeenCalledTimes(3); // Initial + 2 retries
      const execution = graph.getExecution("node1");
      expect(execution?.status).toBe(NodeStatus.FAILED);
    });
  });

  describe("timeout", () => {
    it("should timeout long-running nodes", async () => {
      const slowHandler: NodeHandler = {
        execute: vi
          .fn()
          .mockImplementation(
            () => new Promise((resolve) => setTimeout(resolve, 5000)),
          ),
      };

      const definition: GraphDefinition = {
        id: "timeout-graph",
        name: "Timeout Graph",
        nodes: [
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1",
            dependencies: [],
            config: {},
            timeout: 1000,
          },
        ],
        entryNodes: ["node1"],
      };

      const graph = new ExecutionGraph(definition);
      graph.registerHandler(NodeType.TASK, slowHandler);

      await expect(graph.execute()).rejects.toThrow("timed out");

      const execution = graph.getExecution("node1");
      expect(execution?.status).toBe(NodeStatus.FAILED);
    });
  });

  describe("context and outputs", () => {
    it("should share context between nodes", async () => {
      const contextHandler: NodeHandler = {
        execute: vi.fn((node, context) => {
          if (node.id === "node1") {
            context.variables.set("sharedValue", 42);
            return Promise.resolve({ value: 10 });
          } else {
            const sharedValue = context.variables.get("sharedValue");
            const previousOutput = context.outputs.get("node1");
            return Promise.resolve({
              value: sharedValue + previousOutput.value,
            });
          }
        }),
      };

      const definition: GraphDefinition = {
        id: "context-graph",
        name: "Context Graph",
        nodes: [
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1",
            dependencies: [],
            config: {},
          },
          {
            id: "node2",
            type: NodeType.TASK,
            name: "Node 2",
            dependencies: ["node1"],
            config: {},
          },
        ],
        entryNodes: ["node1"],
      };

      const graph = new ExecutionGraph(definition);
      graph.registerHandler(NodeType.TASK, contextHandler);

      const result = await graph.execute();

      expect(result.success).toBe(true);
      expect(result.outputs["node2"].value).toBe(52); // 42 + 10
    });
  });

  describe("events", () => {
    it("should emit execution lifecycle events", async () => {
      const events: string[] = [];

      const definition: GraphDefinition = {
        id: "events-graph",
        name: "Events Graph",
        nodes: [
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1",
            dependencies: [],
            config: {},
          },
        ],
        entryNodes: ["node1"],
      };

      const graph = new ExecutionGraph(definition);
      graph.registerHandler(NodeType.TASK, simpleTaskHandler);

      graph.on("execution:started", () => events.push("execution:started"));
      graph.on("node:started", () => events.push("node:started"));
      graph.on("node:completed", () => events.push("node:completed"));
      graph.on("execution:completed", () => events.push("execution:completed"));

      await graph.execute();

      expect(events).toEqual([
        "execution:started",
        "node:started",
        "node:completed",
        "execution:completed",
      ]);
    });

    it("should emit retry events", async () => {
      let attempts = 0;
      const retryEvents: any[] = [];

      const retryHandler: NodeHandler = {
        execute: vi.fn().mockImplementation(() => {
          attempts++;
          if (attempts < 2) {
            return Promise.reject(new Error("Temporary failure"));
          }
          return Promise.resolve({ result: "success" });
        }),
      };

      const definition: GraphDefinition = {
        id: "retry-events-graph",
        name: "Retry Events Graph",
        nodes: [
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1",
            dependencies: [],
            config: {},
            retryPolicy: { maxRetries: 2, backoffMs: 10, exponential: false },
          },
        ],
        entryNodes: ["node1"],
      };

      const graph = new ExecutionGraph(definition);
      graph.registerHandler(NodeType.TASK, retryHandler);
      graph.on("node:retry", (event) => retryEvents.push(event));

      await graph.execute();

      expect(retryEvents).toHaveLength(1);
      expect(retryEvents[0].nodeId).toBe("node1");
    });
  });

  describe("concurrency control", () => {
    it("should respect concurrency limit", async () => {
      let activeExecutions = 0;
      let maxConcurrent = 0;

      const concurrentHandler: NodeHandler = {
        execute: vi.fn().mockImplementation(async () => {
          activeExecutions++;
          maxConcurrent = Math.max(maxConcurrent, activeExecutions);
          await new Promise((resolve) => setTimeout(resolve, 50));
          activeExecutions--;
          return { result: "success" };
        }),
      };

      const definition: GraphDefinition = {
        id: "concurrent-graph",
        name: "Concurrent Graph",
        nodes: [
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1",
            dependencies: [],
            config: {},
          },
          {
            id: "node2",
            type: NodeType.TASK,
            name: "Node 2",
            dependencies: [],
            config: {},
          },
          {
            id: "node3",
            type: NodeType.TASK,
            name: "Node 3",
            dependencies: [],
            config: {},
          },
          {
            id: "node4",
            type: NodeType.TASK,
            name: "Node 4",
            dependencies: [],
            config: {},
          },
          {
            id: "node5",
            type: NodeType.TASK,
            name: "Node 5",
            dependencies: [],
            config: {},
          },
        ],
        entryNodes: ["node1", "node2", "node3", "node4", "node5"],
      };

      const graph = new ExecutionGraph(definition, 2); // Limit to 2 concurrent
      graph.registerHandler(NodeType.TASK, concurrentHandler);

      await graph.execute();

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });
  });

  describe("handler registration", () => {
    it("should return true for registered handlers", () => {
      const definition: GraphDefinition = {
        id: "test-graph",
        name: "Test",
        nodes: [
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1",
            dependencies: [],
            config: {},
          },
        ],
        entryNodes: ["node1"],
      };

      const graph = new ExecutionGraph(definition);
      graph.registerHandler(NodeType.TASK, simpleTaskHandler);

      expect(graph.hasHandler(NodeType.TASK)).toBe(true);
    });

    it("should return false for unregistered handlers", () => {
      const definition: GraphDefinition = {
        id: "test-graph",
        name: "Test",
        nodes: [
          {
            id: "node1",
            type: NodeType.TASK,
            name: "Node 1",
            dependencies: [],
            config: {},
          },
        ],
        entryNodes: ["node1"],
      };

      const graph = new ExecutionGraph(definition);
      // Don't register any handlers

      expect(graph.hasHandler(NodeType.TASK)).toBe(false);
      expect(graph.hasHandler(NodeType.CONDITION)).toBe(false);
      expect(graph.hasHandler(NodeType.LOOP)).toBe(false);
    });
  });
});
