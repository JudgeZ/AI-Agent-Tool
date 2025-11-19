import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MessageBus,
  SharedContextManager,
  MessageType,
  MessagePriority,
  ContextScope,
  MessageHandler,
} from "./AgentCommunication";

describe("MessageBus", () => {
  let messageBus: MessageBus;

  beforeEach(() => {
    messageBus = new MessageBus({
      maxQueueSize: 100,
      defaultTtl: 5000,
      cleanupInterval: 0, // Disable auto-cleanup for tests
      maxRetries: 3,
    });
  });

  afterEach(() => {
    messageBus.shutdown();
  });

  describe("agent registration", () => {
    it("should register an agent", () => {
      messageBus.registerAgent("agent1");
      expect(messageBus.getRegisteredAgents()).toContain("agent1");
    });

    it("should unregister an agent", () => {
      messageBus.registerAgent("agent1");
      messageBus.unregisterAgent("agent1");
      expect(messageBus.getRegisteredAgents()).not.toContain("agent1");
    });

    it("should emit registration events", () => {
      const registeredSpy = vi.fn();
      messageBus.on("agent:registered", registeredSpy);

      messageBus.registerAgent("agent1");

      expect(registeredSpy).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "agent1" }),
      );
    });
  });

  describe("message sending", () => {
    beforeEach(() => {
      messageBus.registerAgent("agent1");
      messageBus.registerAgent("agent2");
    });

    it("should send a message to a single agent", async () => {
      const messageId = await messageBus.send({
        type: MessageType.NOTIFICATION,
        from: "agent1",
        to: "agent2",
        payload: { text: "Hello" },
        priority: MessagePriority.NORMAL,
      });

      expect(messageId).toBeDefined();
      expect(messageBus.getQueueSize("agent2")).toBe(1);
    });

    it("should send a message to multiple agents", async () => {
      messageBus.registerAgent("agent3");

      await messageBus.send({
        type: MessageType.NOTIFICATION,
        from: "agent1",
        to: ["agent2", "agent3"],
        payload: { text: "Hello all" },
        priority: MessagePriority.NORMAL,
      });

      expect(messageBus.getQueueSize("agent2")).toBe(1);
      expect(messageBus.getQueueSize("agent3")).toBe(1);
    });

    it("should broadcast a message to all agents", async () => {
      messageBus.registerAgent("agent3");

      await messageBus.send({
        type: MessageType.BROADCAST,
        from: "agent1",
        payload: { text: "Broadcast message" },
        priority: MessagePriority.NORMAL,
      });

      expect(messageBus.getQueueSize("agent2")).toBe(1);
      expect(messageBus.getQueueSize("agent3")).toBe(1);
      expect(messageBus.getQueueSize("agent1")).toBe(0); // Sender not included
    });

    it("should reject message to unregistered agent", async () => {
      await expect(
        messageBus.send({
          type: MessageType.NOTIFICATION,
          from: "agent1",
          to: "nonexistent",
          payload: {},
          priority: MessagePriority.NORMAL,
        }),
      ).rejects.toThrow("not registered");
    });

    it("should reject message when queue is full", async () => {
      const smallBus = new MessageBus({ maxQueueSize: 2 });
      smallBus.registerAgent("agent1");
      smallBus.registerAgent("agent2");

      await smallBus.send({
        type: MessageType.NOTIFICATION,
        from: "agent1",
        to: "agent2",
        payload: {},
        priority: MessagePriority.NORMAL,
      });

      await smallBus.send({
        type: MessageType.NOTIFICATION,
        from: "agent1",
        to: "agent2",
        payload: {},
        priority: MessagePriority.NORMAL,
      });

      await expect(
        smallBus.send({
          type: MessageType.NOTIFICATION,
          from: "agent1",
          to: "agent2",
          payload: {},
          priority: MessagePriority.NORMAL,
        }),
      ).rejects.toThrow("Queue full");

      smallBus.shutdown();
    });
  });

  describe("message priority", () => {
    beforeEach(() => {
      messageBus.registerAgent("agent1");
      messageBus.registerAgent("agent2");
    });

    it("should deliver high priority messages first", async () => {
      const deliveredMessages: string[] = [];

      const handler: MessageHandler = {
        handle: vi.fn((message) => {
          deliveredMessages.push(message.payload.order);
          return Promise.resolve();
        }),
      };

      messageBus.registerHandler("agent2", MessageType.NOTIFICATION, handler);

      // Send messages without awaiting so they queue up before any delivery completes
      const sends = [
        messageBus.send({
          type: MessageType.NOTIFICATION,
          from: "agent1",
          to: "agent2",
          payload: { order: "low" },
          priority: MessagePriority.LOW,
        }),
        messageBus.send({
          type: MessageType.NOTIFICATION,
          from: "agent1",
          to: "agent2",
          payload: { order: "normal" },
          priority: MessagePriority.NORMAL,
        }),
        messageBus.send({
          type: MessageType.NOTIFICATION,
          from: "agent1",
          to: "agent2",
          payload: { order: "high" },
          priority: MessagePriority.HIGH,
        }),
      ];

      // Wait for all sends and deliveries to complete
      await Promise.all(sends);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(deliveredMessages).toEqual(["high", "normal", "low"]);
    });
  });

  describe("message handling", () => {
    beforeEach(() => {
      messageBus.registerAgent("agent1");
      messageBus.registerAgent("agent2");
    });

    it("should deliver message to registered handler", async () => {
      const handler: MessageHandler = {
        handle: vi.fn().mockResolvedValue(undefined),
      };

      messageBus.registerHandler(
        "agent2",
        MessageType.NOTIFICATION,
        handler,
      );

      await messageBus.send({
        type: MessageType.NOTIFICATION,
        from: "agent1",
        to: "agent2",
        payload: { text: "Test" },
        priority: MessagePriority.NORMAL,
      });

      // Wait for delivery
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(handler.handle).toHaveBeenCalled();
    });

    it("should emit delivery event", async () => {
      const deliveredSpy = vi.fn();
      messageBus.on("message:delivered", deliveredSpy);

      const handler: MessageHandler = {
        handle: vi.fn().mockResolvedValue(undefined),
      };

      messageBus.registerHandler(
        "agent2",
        MessageType.NOTIFICATION,
        handler,
      );

      await messageBus.send({
        type: MessageType.NOTIFICATION,
        from: "agent1",
        to: "agent2",
        payload: {},
        priority: MessagePriority.NORMAL,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(deliveredSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "agent2",
          latency: expect.any(Number),
        }),
      );
    });

    it("should retry failed message delivery", async () => {
      let attempts = 0;

      const handler: MessageHandler = {
        handle: vi.fn().mockImplementation(() => {
          attempts++;
          if (attempts < 3) {
            return Promise.reject(new Error("Temporary failure"));
          }
          return Promise.resolve();
        }),
      };

      messageBus.registerHandler(
        "agent2",
        MessageType.NOTIFICATION,
        handler,
      );

      await messageBus.send({
        type: MessageType.NOTIFICATION,
        from: "agent1",
        to: "agent2",
        payload: {},
        priority: MessagePriority.NORMAL,
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(attempts).toBe(3);
    });

    it("should fail message after max retries", async () => {
      const failedSpy = vi.fn();
      messageBus.on("message:failed", failedSpy);

      const handler: MessageHandler = {
        handle: vi.fn().mockRejectedValue(new Error("Persistent failure")),
      };

      messageBus.registerHandler(
        "agent2",
        MessageType.NOTIFICATION,
        handler,
      );

      await messageBus.send({
        type: MessageType.NOTIFICATION,
        from: "agent1",
        to: "agent2",
        payload: {},
        priority: MessagePriority.NORMAL,
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(failedSpy).toHaveBeenCalled();
      expect(handler.handle).toHaveBeenCalledTimes(4); // Initial + 3 retries
    });
  });

  describe("request-response pattern", () => {
    beforeEach(() => {
      messageBus.registerAgent("agent1");
      messageBus.registerAgent("agent2");
    });

    it("should handle request-response", async () => {
      const handler: MessageHandler = {
        handle: vi.fn().mockResolvedValue({ result: "success" }),
      };

      messageBus.registerHandler("agent2", MessageType.REQUEST, handler);

      const response = await messageBus.request("agent1", "agent2", {
        query: "test",
      });

      expect(response).toEqual({ result: "success" });
    });

    it("should timeout request after specified duration", async () => {
      const handler: MessageHandler = {
        handle: vi
          .fn()
          .mockImplementation(
            () => new Promise((resolve) => setTimeout(resolve, 5000)),
          ),
      };

      messageBus.registerHandler("agent2", MessageType.REQUEST, handler);

      await expect(
        messageBus.request("agent1", "agent2", { query: "test" }, 100),
      ).rejects.toThrow("timeout");
    });

    it("should reject request on handler error", async () => {
      const handler: MessageHandler = {
        handle: vi.fn().mockRejectedValue(new Error("Handler error")),
      };

      messageBus.registerHandler("agent2", MessageType.REQUEST, handler);

      await expect(
        messageBus.request("agent1", "agent2", { query: "test" }),
      ).rejects.toThrow("Handler error");
    });
  });

  describe("metrics", () => {
    beforeEach(() => {
      messageBus.registerAgent("agent1");
      messageBus.registerAgent("agent2");
    });

    it("should track message metrics", async () => {
      const handler: MessageHandler = {
        handle: vi.fn().mockResolvedValue(undefined),
      };

      messageBus.registerHandler(
        "agent2",
        MessageType.NOTIFICATION,
        handler,
      );

      await messageBus.send({
        type: MessageType.NOTIFICATION,
        from: "agent1",
        to: "agent2",
        payload: {},
        priority: MessagePriority.NORMAL,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const metrics = messageBus.getMetrics();

      expect(metrics.messagesSent).toBe(1);
      expect(metrics.messagesDelivered).toBe(1);
      expect(metrics.messagesFailed).toBe(0);
    });
  });
});

describe("SharedContextManager", () => {
  let contextManager: SharedContextManager;

  beforeEach(() => {
    contextManager = new SharedContextManager({
      maxEntries: 100,
      defaultTtl: 60000,
      cleanupInterval: 0,
      enableVersioning: true,
    });
  });

  afterEach(() => {
    contextManager.shutdown();
  });

  describe("basic operations", () => {
    it("should set and get a value", () => {
      contextManager.set("key1", "value1", "agent1", ContextScope.PRIVATE);
      const value = contextManager.get("key1", "agent1");
      expect(value).toBe("value1");
    });

    it("should delete a value", () => {
      contextManager.set("key1", "value1", "agent1", ContextScope.PRIVATE);
      contextManager.delete("key1", "agent1");
      const value = contextManager.get("key1", "agent1");
      expect(value).toBeUndefined();
    });

    it("should update version on set", () => {
      const setSpy = vi.fn();
      contextManager.on("context:set", setSpy);

      contextManager.set("key1", "value1", "agent1");
      contextManager.set("key1", "value2", "agent1");

      expect(setSpy).toHaveBeenCalledTimes(2);
      expect(setSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ version: 2 }),
      );
    });

    it("should reject access when full", () => {
      const smallManager = new SharedContextManager({ maxEntries: 2 });

      smallManager.set("key1", "value1", "agent1");
      smallManager.set("key2", "value2", "agent1");

      expect(() => smallManager.set("key3", "value3", "agent1")).toThrow(
        "full",
      );

      smallManager.shutdown();
    });
  });

  describe("access control", () => {
    it("should allow owner to access private context", () => {
      contextManager.set("key1", "value1", "agent1", ContextScope.PRIVATE);
      expect(contextManager.get("key1", "agent1")).toBe("value1");
    });

    it("should deny non-owner access to private context", () => {
      contextManager.set("key1", "value1", "agent1", ContextScope.PRIVATE);
      expect(() => contextManager.get("key1", "agent2")).toThrow(
        "Access denied",
      );
    });

    it("should allow all agents to access global context", () => {
      contextManager.set("key1", "value1", "agent1", ContextScope.GLOBAL);

      expect(contextManager.get("key1", "agent1")).toBe("value1");
      expect(contextManager.get("key1", "agent2")).toBe("value1");
      expect(contextManager.get("key1", "agent3")).toBe("value1");
    });

    it("should allow sharing with specific agents", () => {
      contextManager.set("key1", "value1", "agent1", ContextScope.PRIVATE);
      contextManager.share("key1", "agent1", ["agent2", "agent3"]);

      expect(contextManager.get("key1", "agent2")).toBe("value1");
      expect(contextManager.get("key1", "agent3")).toBe("value1");
      expect(() => contextManager.get("key1", "agent4")).toThrow(
        "Access denied",
      );
    });

    it("should only allow owner to delete", () => {
      contextManager.set("key1", "value1", "agent1", ContextScope.PRIVATE);

      expect(() => contextManager.delete("key1", "agent2")).toThrow(
        "Only owner",
      );
      expect(contextManager.delete("key1", "agent1")).toBe(true);
    });

    it("should only allow owner to share", () => {
      contextManager.set("key1", "value1", "agent1", ContextScope.PRIVATE);

      expect(() => contextManager.share("key1", "agent2", ["agent3"])).toThrow(
        "Only owner",
      );
    });
  });

  describe("querying", () => {
    beforeEach(() => {
      contextManager.set(
        "app.config.timeout",
        30000,
        "agent1",
        ContextScope.GLOBAL,
      );
      contextManager.set(
        "app.config.retries",
        3,
        "agent1",
        ContextScope.GLOBAL,
      );
      contextManager.set(
        "user.data",
        { name: "Alice" },
        "agent2",
        ContextScope.PRIVATE,
      );
      contextManager.set("session.id", "123", "agent3", ContextScope.PIPELINE);
    });

    it("should query by scope", () => {
      const results = contextManager.query(
        { scope: [ContextScope.GLOBAL] },
        "agent1",
      );
      expect(results).toHaveLength(2);
    });

    it("should query by owner", () => {
      const results = contextManager.query({ ownerId: "agent1" }, "agent1");
      expect(results).toHaveLength(2);
    });

    it("should query by prefix", () => {
      const results = contextManager.query({ prefix: "app.config" }, "agent1");
      expect(results).toHaveLength(2);
      expect(results.every((e) => e.key.startsWith("app.config"))).toBe(true);
    });

    it("should query by pattern", () => {
      const results = contextManager.query({ pattern: /\.config\./ }, "agent1");
      expect(results).toHaveLength(2);
    });

    it("should respect access control in queries", () => {
      const results = contextManager.query({}, "agent4");
      expect(results).toHaveLength(2); // Only global entries
    });
  });

  describe("TTL and expiration", () => {
    it("should expire context entries after TTL", () => {
      contextManager.set("key1", "value1", "agent1", ContextScope.PRIVATE, 100);

      expect(contextManager.get("key1", "agent1")).toBe("value1");

      // Wait for expiration
      return new Promise((resolve) => {
        setTimeout(() => {
          expect(contextManager.get("key1", "agent1")).toBeUndefined();
          resolve(undefined);
        }, 150);
      });
    });

    it("should emit expiration event", () => {
      return new Promise<void>((resolve) => {
        const expiredSpy = vi.fn();
        contextManager.on("context:expired", expiredSpy);

        contextManager.set(
          "key1",
          "value1",
          "agent1",
          ContextScope.PRIVATE,
          50,
        );

        setTimeout(() => {
          contextManager.get("key1", "agent1"); // Trigger expiration check
          expect(expiredSpy).toHaveBeenCalledWith(
            expect.objectContaining({ key: "key1" }),
          );
          resolve();
        }, 100);
      });
    });
  });

  describe("utility methods", () => {
    it("should return entry count", () => {
      contextManager.set("key1", "value1", "agent1");
      contextManager.set("key2", "value2", "agent1");

      expect(contextManager.getEntryCount()).toBe(2);
    });

    it("should return keys by scope", () => {
      contextManager.set("key1", "value1", "agent1", ContextScope.GLOBAL);
      contextManager.set("key2", "value2", "agent1", ContextScope.PRIVATE);

      const globalKeys = contextManager.getKeys(ContextScope.GLOBAL);
      expect(globalKeys).toEqual(["key1"]);
    });

    it("should return all keys", () => {
      contextManager.set("key1", "value1", "agent1");
      contextManager.set("key2", "value2", "agent1");

      const allKeys = contextManager.getKeys();
      expect(allKeys).toHaveLength(2);
    });
  });

  describe("events", () => {
    it("should emit set event", () => {
      const setSpy = vi.fn();
      contextManager.on("context:set", setSpy);

      contextManager.set("key1", "value1", "agent1");

      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "key1",
          ownerId: "agent1",
        }),
      );
    });

    it("should emit get event", () => {
      const getSpy = vi.fn();
      contextManager.on("context:get", getSpy);

      contextManager.set("key1", "value1", "agent1");
      contextManager.get("key1", "agent1");

      expect(getSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "key1",
          requesterId: "agent1",
        }),
      );
    });

    it("should emit delete event", () => {
      const deleteSpy = vi.fn();
      contextManager.on("context:delete", deleteSpy);

      contextManager.set("key1", "value1", "agent1");
      contextManager.delete("key1", "agent1");

      expect(deleteSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "key1",
          ownerId: "agent1",
        }),
      );
    });

    it("should emit shared event", () => {
      const sharedSpy = vi.fn();
      contextManager.on("context:shared", sharedSpy);

      contextManager.set("key1", "value1", "agent1");
      contextManager.share("key1", "agent1", ["agent2"]);

      expect(sharedSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "key1",
          ownerId: "agent1",
          agentIds: ["agent2"],
        }),
      );
    });
  });
});
