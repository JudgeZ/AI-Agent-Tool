import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "./ToolRegistry";
import {
  McpTool,
  ToolContext,
  createToolMetadata,
  ToolCapability,
} from "./McpTool";
import { SandboxType } from "../sandbox";
import pino from "pino";

// Mock tool for testing
class MockTool extends McpTool<{ value: number }, { result: number }> {
  protected async executeImpl(
    input: { value: number },
    context: ToolContext,
  ): Promise<{ result: number }> {
    return { result: input.value * 2 };
  }
}

describe("ToolRegistry", () => {
  const logger = pino({ level: "silent" });
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry(logger);
  });

  describe("Registration", () => {
    it("should register a tool", () => {
      const metadata = createToolMetadata({
        id: "test-tool",
        name: "Test Tool",
        description: "A test tool",
        capabilities: [ToolCapability.READ_FILES],
        inputSchema: { type: "object" },
      });

      const tool = new MockTool(metadata, logger);
      registry.register(tool);

      const retrieved = registry.get("test-tool");
      expect(retrieved).toBeDefined();
      expect(retrieved?.getMetadata().id).toBe("test-tool");
    });

    it("should prevent duplicate registration by default", () => {
      const metadata = createToolMetadata({
        id: "test-tool",
        name: "Test Tool",
        description: "A test tool",
        capabilities: [ToolCapability.READ_FILES],
        inputSchema: { type: "object" },
      });

      const tool1 = new MockTool(metadata, logger);
      const tool2 = new MockTool(metadata, logger);

      registry.register(tool1);

      expect(() => registry.register(tool2)).toThrow("already registered");
    });

    it("should allow overwrite when explicitly enabled", () => {
      const metadata = createToolMetadata({
        id: "test-tool",
        name: "Test Tool",
        description: "A test tool",
        capabilities: [ToolCapability.READ_FILES],
        inputSchema: { type: "object" },
      });

      const tool1 = new MockTool(metadata, logger);
      const tool2 = new MockTool(metadata, logger);

      registry.register(tool1);
      registry.register(tool2, { allowOverwrite: true });

      expect(registry.get("test-tool")).toBe(tool2);
    });

    it("should emit registered event", () => {
      const metadata = createToolMetadata({
        id: "test-tool",
        name: "Test Tool",
        description: "A test tool",
        capabilities: [ToolCapability.READ_FILES],
        inputSchema: { type: "object" },
      });

      const tool = new MockTool(metadata, logger);

      return new Promise<void>((resolve) => {
        registry.on("registered", ({ tool: registeredTool }) => {
          expect(registeredTool.id).toBe("test-tool");
          resolve();
        });

        registry.register(tool);
      });
    });
  });

  describe("Unregistration", () => {
    it("should unregister a tool", () => {
      const metadata = createToolMetadata({
        id: "test-tool",
        name: "Test Tool",
        description: "A test tool",
        capabilities: [ToolCapability.READ_FILES],
        inputSchema: { type: "object" },
      });

      const tool = new MockTool(metadata, logger);
      registry.register(tool);

      const result = registry.unregister("test-tool");

      expect(result).toBe(true);
      expect(registry.get("test-tool")).toBeUndefined();
    });

    it("should return false for non-existent tool", () => {
      const result = registry.unregister("non-existent");
      expect(result).toBe(false);
    });
  });

  describe("Listing and Discovery", () => {
    beforeEach(() => {
      const tools = [
        createToolMetadata({
          id: "read-tool",
          name: "Read Tool",
          description: "Reads files",
          capabilities: [ToolCapability.READ_FILES],
          inputSchema: { type: "object" },
          tags: ["filesystem"],
        }),
        createToolMetadata({
          id: "write-tool",
          name: "Write Tool",
          description: "Writes files",
          capabilities: [ToolCapability.WRITE_FILES],
          inputSchema: { type: "object" },
          tags: ["filesystem"],
        }),
        createToolMetadata({
          id: "network-tool",
          name: "Network Tool",
          description: "Makes network requests",
          capabilities: [ToolCapability.NETWORK_ACCESS],
          inputSchema: { type: "object" },
          tags: ["network"],
        }),
      ];

      tools.forEach((metadata) => {
        registry.register(new MockTool(metadata, logger));
      });
    });

    it("should list all tools", () => {
      const tools = registry.list();
      expect(tools).toHaveLength(3);
      expect(tools.map((t) => t.id)).toEqual([
        "read-tool",
        "write-tool",
        "network-tool",
      ]);
    });

    it("should find tools by capability", () => {
      const tools = registry.findByCapability(ToolCapability.READ_FILES);
      expect(tools).toHaveLength(1);
      expect(tools[0].id).toBe("read-tool");
    });

    it("should find tools by tag", () => {
      const tools = registry.findByTag("filesystem");
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.id)).toContain("read-tool");
      expect(tools.map((t) => t.id)).toContain("write-tool");
    });

    it("should search tools by name", () => {
      const tools = registry.search("network");
      expect(tools).toHaveLength(1);
      expect(tools[0].id).toBe("network-tool");
    });

    it("should search tools by description", () => {
      const tools = registry.search("files");
      expect(tools).toHaveLength(2);
    });
  });

  describe("Enable/Disable", () => {
    it("should disable a tool", () => {
      const metadata = createToolMetadata({
        id: "test-tool",
        name: "Test Tool",
        description: "A test tool",
        capabilities: [ToolCapability.READ_FILES],
        inputSchema: { type: "object" },
      });

      const tool = new MockTool(metadata, logger);
      registry.register(tool);

      registry.disable("test-tool");

      expect(registry.get("test-tool")).toBeUndefined();
      expect(registry.isEnabled("test-tool")).toBe(false);
    });

    it("should re-enable a disabled tool", () => {
      const metadata = createToolMetadata({
        id: "test-tool",
        name: "Test Tool",
        description: "A test tool",
        capabilities: [ToolCapability.READ_FILES],
        inputSchema: { type: "object" },
      });

      const tool = new MockTool(metadata, logger);
      registry.register(tool);

      registry.disable("test-tool");
      registry.enable("test-tool");

      expect(registry.get("test-tool")).toBeDefined();
      expect(registry.isEnabled("test-tool")).toBe(true);
    });

    it("should exclude disabled tools from listing by default", () => {
      const metadata = createToolMetadata({
        id: "test-tool",
        name: "Test Tool",
        description: "A test tool",
        capabilities: [ToolCapability.READ_FILES],
        inputSchema: { type: "object" },
      });

      const tool = new MockTool(metadata, logger);
      registry.register(tool);
      registry.disable("test-tool");

      const tools = registry.list();
      expect(tools).toHaveLength(0);
    });
  });

  describe("Statistics", () => {
    it("should track tool execution stats", async () => {
      const metadata = createToolMetadata({
        id: "test-tool",
        name: "Test Tool",
        description: "A test tool",
        capabilities: [ToolCapability.READ_FILES],
        inputSchema: { type: "object" },
      });

      const tool = new MockTool(metadata, logger);
      registry.register(tool);

      const context: ToolContext = {
        requestId: "test-request",
        logger,
        workdir: "/tmp",
      };

      await tool.execute({ value: 5 }, context);

      const stats = registry.getStats("test-tool");
      expect(stats?.executions).toBe(1);
      expect(stats?.failures).toBe(0);
      expect(stats?.totalDuration).toBeGreaterThanOrEqual(0);
    });

    it("should get registry-wide statistics", async () => {
      const metadata = createToolMetadata({
        id: "test-tool",
        name: "Test Tool",
        description: "A test tool",
        capabilities: [ToolCapability.READ_FILES],
        inputSchema: { type: "object" },
      });

      const tool = new MockTool(metadata, logger);
      registry.register(tool);

      const context: ToolContext = {
        requestId: "test-request",
        logger,
        workdir: "/tmp",
      };

      await tool.execute({ value: 5 }, context);

      const stats = registry.getRegistryStats();
      expect(stats.totalTools).toBe(1);
      expect(stats.enabledTools).toBe(1);
      expect(stats.totalExecutions).toBe(1);
    });
  });

  describe("Validation", () => {
    it("should validate tool metadata", async () => {
      const invalidMetadata = createToolMetadata({
        id: "",
        name: "",
        description: "Invalid tool",
        capabilities: [],
        inputSchema: { type: "object" },
      });

      const tool = new MockTool(invalidMetadata, logger);
      registry.register(tool, { allowOverwrite: true });

      const errors = await registry.validate();
      expect(errors.size).toBeGreaterThan(0);
    });

    it("should pass validation for valid tools", async () => {
      const metadata = createToolMetadata({
        id: "test-tool",
        name: "Test Tool",
        description: "A test tool",
        capabilities: [ToolCapability.READ_FILES],
        inputSchema: { type: "object" },
      });

      const tool = new MockTool(metadata, logger);
      registry.register(tool);

      const errors = await registry.validate();
      expect(errors.size).toBe(0);
    });
  });
});
