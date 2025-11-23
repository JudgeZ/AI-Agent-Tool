import { EventEmitter } from "node:events";

import { WebSocket } from "ws";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppLogger } from "../observability/logger.js";
vi.mock("node-pty", () => ({ spawn: vi.fn() }));
import { TerminalManager } from "./TerminalManager.js";

class MockDisposable {
  constructor(private readonly onDispose: () => void) {}

  dispose(): void {
    this.onDispose();
  }
}

class MockPty {
  public writes: string[] = [];
  public resizes: Array<{ cols: number; rows: number }> = [];
  public killed = false;
  private dataCallbacks: Array<(data: string) => void> = [];
  private exitCallbacks: Array<(event: { exitCode: number; signal?: number }) => void> = [];

  onData(callback: (data: string) => void): MockDisposable {
    this.dataCallbacks.push(callback);
    return new MockDisposable(() => {
      this.dataCallbacks = this.dataCallbacks.filter((entry) => entry !== callback);
    });
  }

  onExit(callback: (event: { exitCode: number; signal?: number }) => void): MockDisposable {
    this.exitCallbacks.push(callback);
    return new MockDisposable(() => {
      this.exitCallbacks = this.exitCallbacks.filter((entry) => entry !== callback);
    });
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
  }

  emitData(data: string): void {
    for (const callback of this.dataCallbacks) {
      callback(data);
    }
  }

  emitExit(exitCode: number, signal?: number): void {
    for (const callback of this.exitCallbacks) {
      callback({ exitCode, signal });
    }
  }
}

class MockSocket extends EventEmitter {
  public messages: string[] = [];
  public readyState = WebSocket.OPEN;
  public closed = false;
  public closeCode: number | undefined;
  public closeReason: string | undefined;
  public throwOnSend = false;

  send(data: string): void {
    if (this.throwOnSend) {
      throw new Error("send failed");
    }
    this.messages.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = WebSocket.CLOSED;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit("close");
  }
}

const logger: AppLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  level: "info",
  levels: {
    values: {},
    labels: {},
  } as any,
  version: "", // unused
  bindings: () => ({}),
  flush: () => {},
  isLevelEnabled: () => true,
  levelVal: 30,
  child: () => logger,
} as AppLogger;

describe("TerminalManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("broadcasts terminal output to all attached clients", () => {
    const pty = new MockPty();
    const manager = new TerminalManager({ spawnImpl: () => pty as any, logger });
    const socketA = new MockSocket();
    const socketB = new MockSocket();

    manager.attach("session-1", socketA as unknown as WebSocket);
    manager.attach("session-1", socketB as unknown as WebSocket);

    pty.emitData("hello world");

    const payloadA = JSON.parse(socketA.messages[socketA.messages.length - 1] ?? "{}") as { type?: string; data?: string };
    const payloadB = JSON.parse(socketB.messages[socketB.messages.length - 1] ?? "{}") as { type?: string; data?: string };

    expect(payloadA).toMatchObject({ type: "output", data: "hello world" });
    expect(payloadB).toMatchObject({ type: "output", data: "hello world" });
  });

  it("broadcasts connection status changes to all clients", () => {
    const pty = new MockPty();
    const manager = new TerminalManager({ spawnImpl: () => pty as any, logger });
    const socketA = new MockSocket();
    const socketB = new MockSocket();

    manager.attach("session-status", socketA as unknown as WebSocket);
    const firstStatus = JSON.parse(socketA.messages[socketA.messages.length - 1] ?? "{}") as
      | { type?: string; status?: string; clients?: number }
      | undefined;
    expect(firstStatus).toMatchObject({ type: "status", status: "connected", clients: 1 });

    manager.attach("session-status", socketB as unknown as WebSocket);
    const statusA = JSON.parse(socketA.messages[socketA.messages.length - 1] ?? "{}") as
      | { type?: string; status?: string; clients?: number }
      | undefined;
    const statusB = JSON.parse(socketB.messages[socketB.messages.length - 1] ?? "{}") as
      | { type?: string; status?: string; clients?: number }
      | undefined;
    expect(statusA).toMatchObject({ type: "status", status: "connected", clients: 2 });
    expect(statusB).toMatchObject({ type: "status", status: "connected", clients: 2 });

    socketB.close();
    const afterDisconnect = JSON.parse(socketA.messages[socketA.messages.length - 1] ?? "{}") as
      | { type?: string; status?: string; clients?: number }
      | undefined;
    expect(afterDisconnect).toMatchObject({ type: "status", status: "disconnected", clients: 1 });
  });

  it("closes sockets when a terminal session fails to start", () => {
    const manager = new TerminalManager({
      spawnImpl: () => {
        throw new Error("pty spawn failed");
      },
      logger,
    });
    const socket = new MockSocket();

    const attached = manager.attach("session-spawn-failure", socket as unknown as WebSocket);

    expect(attached).toBe("failed");
    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(1011);
    expect(socket.closeReason).toBe("terminal unavailable");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-spawn-failure", err: expect.anything() }),
      "failed to start terminal session",
    );
  });

  it("cleans up failed sessions so subsequent attaches can retry", () => {
    const pty = new MockPty();
    const spawnImpl = vi.fn();
    spawnImpl.mockImplementationOnce(() => {
      throw new Error("first spawn failed");
    });
    spawnImpl.mockImplementationOnce(() => pty as any);

    const manager = new TerminalManager({ spawnImpl: spawnImpl as any, logger });
    const firstSocket = new MockSocket();
    const secondSocket = new MockSocket();

    const firstAttached = manager.attach("session-retry", firstSocket as unknown as WebSocket);
    expect(firstAttached).toBe("failed");
    expect(firstSocket.closed).toBe(true);
    expect(firstSocket.closeReason).toBe("terminal unavailable");

    const secondAttached = manager.attach("session-retry", secondSocket as unknown as WebSocket);
    expect(secondAttached).toBe("attached");
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(secondSocket.closed).toBe(false);
    const parsed = JSON.parse(secondSocket.messages[0] ?? "{}") as { type?: string; status?: string; clients?: number };
    expect(parsed).toMatchObject({ type: "status", status: "connected", clients: 1 });
  });

  it("queues sockets while a session is being created and attaches them after creation", () => {
    const pty = new MockPty();
    const manager = new TerminalManager({ spawnImpl: () => pty as any, logger });
    const socketA = new MockSocket();
    const socketB = new MockSocket();

    (manager as any).creatingSessions.add("session-queued");
    const pendingResult = manager.attach("session-queued", socketB as unknown as WebSocket);
    expect(pendingResult).toBe("pending");

    (manager as any).creatingSessions.delete("session-queued");

    const attachedResult = manager.attach("session-queued", socketA as unknown as WebSocket);
    expect(attachedResult).toBe("attached");

    const parsedA = JSON.parse(socketA.messages[0] ?? "{}") as { type?: string; status?: string; clients?: number };
    const parsedB = JSON.parse(socketB.messages[0] ?? "{}") as { type?: string; status?: string; clients?: number };

    expect(parsedA).toMatchObject({ type: "status", status: "connected", clients: 1 });
    expect(parsedB).toMatchObject({ type: "status", status: "connected", clients: 2 });
  });

  it("rejects pending attachments when the session creation queue is full", () => {
    const manager = new TerminalManager({ spawnImpl: () => new MockPty() as any, logger, maxPendingClients: 1 });
    const firstPending = new MockSocket();
    const rejected = new MockSocket();

    (manager as any).creatingSessions.add("session-pending-limit");

    const firstResult = manager.attach("session-pending-limit", firstPending as unknown as WebSocket);
    expect(firstResult).toBe("pending");

    const rejectedResult = manager.attach("session-pending-limit", rejected as unknown as WebSocket);
    expect(rejectedResult).toBe("failed");
    expect(rejected.closed).toBe(true);
    expect(rejected.closeCode).toBe(1013);
    expect(rejected.closeReason).toBe("terminal starting, try again later");

    (manager as any).creatingSessions.delete("session-pending-limit");
    manager.attach("session-pending-limit", new MockSocket() as unknown as WebSocket);

    const pendingSockets = (manager as any).pendingClients.get("session-pending-limit");
    expect(pendingSockets?.size ?? 0).toBeLessThanOrEqual(1);
  });

  it("normalizes status payload counts after pruning stale connections without emitting disconnects", () => {
    const pty = new MockPty();
    const manager = new TerminalManager({ spawnImpl: () => pty as any, logger });
    const staleSocket = new MockSocket();
    const activeSocket = new MockSocket();

    manager.attach("session-stale", staleSocket as unknown as WebSocket);
    staleSocket.readyState = WebSocket.CLOSED;

    manager.attach("session-stale", activeSocket as unknown as WebSocket);

    const parsedMessages = activeSocket.messages.map((entry) => JSON.parse(entry) as { type?: string; status?: string; clients?: number });
    const statusMessages = parsedMessages.filter((entry) => entry.type === "status");
    const lastStatus = statusMessages[statusMessages.length - 1];

    expect(statusMessages).toHaveLength(1);
    expect(lastStatus).toMatchObject({ type: "status", status: "connected", clients: 1 });
    expect(staleSocket.messages).toHaveLength(1);
  });

  it("writes input and disposes the pty when all clients detach", () => {
    const pty = new MockPty();
    const manager = new TerminalManager({ spawnImpl: () => pty as any, logger });
    const socket = new MockSocket();

    manager.attach("session-2", socket as unknown as WebSocket);

    socket.emit("message", JSON.stringify({ type: "input", data: "ls\n" }));
    expect(pty.writes).toContain("ls\n");

    socket.close();
    expect(pty.killed).toBe(true);
  });

  it("handles resize messages", () => {
    const pty = new MockPty();
    const manager = new TerminalManager({ spawnImpl: () => pty as any, logger });
    const socket = new MockSocket();

    manager.attach("session-3", socket as unknown as WebSocket);
    socket.emit("message", JSON.stringify({ type: "resize", cols: 120, rows: 40 }));

    expect(pty.resizes).toContainEqual({ cols: 120, rows: 40 });
  });

  it("closes connected clients when the pty exits", () => {
    const pty = new MockPty();
    const manager = new TerminalManager({ spawnImpl: () => pty as any, logger });
    const socketA = new MockSocket();
    const socketB = new MockSocket();

    manager.attach("session-exit", socketA as unknown as WebSocket);
    manager.attach("session-exit", socketB as unknown as WebSocket);

    pty.emitExit(0);

    expect(socketA.closed).toBe(true);
    expect(socketB.closed).toBe(true);
    expect(socketA.closeCode).toBe(1011);
    expect(socketB.closeReason).toBe("terminal session ended");
  });

  it("rejects sockets that have already been closed to avoid orphaning sessions", () => {
    const spawnImpl = vi.fn(() => new MockPty() as any);
    const manager = new TerminalManager({ spawnImpl, logger });
    const socket = new MockSocket();

    socket.readyState = WebSocket.CLOSED;
    manager.attach("session-closed", socket as unknown as WebSocket);

    expect(spawnImpl).not.toHaveBeenCalled();
    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(1011);
    expect(socket.closeReason).toBe("terminal socket closed");
  });

  it("accepts binary websocket payloads", () => {
    const pty = new MockPty();
    const manager = new TerminalManager({ spawnImpl: () => pty as any, logger });
    const socket = new MockSocket();

    manager.attach("session-binary", socket as unknown as WebSocket);

    const buffer = Buffer.from(JSON.stringify({ type: "input", data: "pwd\n" }), "utf8");
    socket.emit("message", buffer);

    expect(pty.writes).toContain("pwd\n");
  });

  it("closes clients that send invalid messages", () => {
    const pty = new MockPty();
    const manager = new TerminalManager({ spawnImpl: () => pty as any, logger });
    const socket = new MockSocket();

    manager.attach("session-invalid", socket as unknown as WebSocket);

    socket.emit("message", "{not-json}");

    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(1008);
    expect(socket.closeReason).toBe("invalid terminal message");
    expect(pty.killed).toBe(true);
  });

  it("uses the too-large close code for oversized messages", () => {
    const pty = new MockPty();
    const manager = new TerminalManager({ spawnImpl: () => pty as any, logger });
    const socket = new MockSocket();

    manager.attach("session-too-large", socket as unknown as WebSocket);

    socket.emit("message", "{" + "x".repeat(20_000) + "}");

    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(1009);
    expect(socket.closeReason).toBe("terminal message too large");
    expect(pty.killed).toBe(true);
  });

  it("cleans up stale websocket clients during broadcasts", () => {
    const pty = new MockPty();
    const manager = new TerminalManager({ spawnImpl: () => pty as any, logger });
    const socket = new MockSocket();

    manager.attach("session-stale", socket as unknown as WebSocket);

    socket.readyState = WebSocket.CLOSED;
    pty.emitData("orphaned output");

    expect(pty.killed).toBe(true);
  });

  it("broadcasts corrected status after pruning stale clients before sending", () => {
    const pty = new MockPty();
    const manager = new TerminalManager({ spawnImpl: () => pty as any, logger });
    const healthySocket = new MockSocket();
    const staleSocket = new MockSocket();

    manager.attach("session-stale-status", healthySocket as unknown as WebSocket);
    manager.attach("session-stale-status", staleSocket as unknown as WebSocket);

    staleSocket.readyState = WebSocket.CLOSING;

    pty.emitData("line 1\n");

    const parsedMessages = healthySocket.messages.map((entry) => JSON.parse(entry) as { type?: string; clients?: number; status?: string });
    const lastMessage = parsedMessages[parsedMessages.length - 1];

    expect(lastMessage).toMatchObject({ type: "status", status: "disconnected", clients: 1 });
    expect(pty.killed).toBe(false);
  });

  it("drops clients that error during broadcast to avoid repeated failures", () => {
    const pty = new MockPty();
    const manager = new TerminalManager({ spawnImpl: () => pty as any, logger });
    const socket = new MockSocket();

    socket.throwOnSend = true;
    manager.attach("session-error", socket as unknown as WebSocket);

    pty.emitData("boom");

    expect(socket.closed).toBe(true);
    expect(socket.closeReason).toBe("terminal delivery failure");
    expect(pty.killed).toBe(true);
  });

  it("sends a corrected status update when a client fails during output delivery", () => {
    const pty = new MockPty();
    const manager = new TerminalManager({ spawnImpl: () => pty as any, logger });
    const failingSocket = new MockSocket();
    const healthySocket = new MockSocket();

    manager.attach("session-output-status", healthySocket as unknown as WebSocket);
    manager.attach("session-output-status", failingSocket as unknown as WebSocket);

    failingSocket.throwOnSend = true;

    pty.emitData("line 1\n");

    const parsedMessages = healthySocket.messages.map((entry) => JSON.parse(entry) as { type?: string; clients?: number; status?: string });
    const lastMessage = parsedMessages[parsedMessages.length - 1];

    expect(lastMessage).toMatchObject({ type: "status", status: "disconnected", clients: 1 });
    expect(failingSocket.closed).toBe(true);
    expect(pty.killed).toBe(false);
  });

  it("replays corrected status counts after dropping failed clients", () => {
    const pty = new MockPty();
    const manager = new TerminalManager({ spawnImpl: () => pty as any, logger });
    const failingSocket = new MockSocket();
    const healthySocket = new MockSocket();

    manager.attach("session-status-retry", failingSocket as unknown as WebSocket);
    failingSocket.throwOnSend = true;

    manager.attach("session-status-retry", healthySocket as unknown as WebSocket);

    const messages = healthySocket.messages.map((entry) => JSON.parse(entry) as { clients?: number; type?: string });
    const lastStatus = messages[messages.length - 1];

    expect(lastStatus).toMatchObject({ type: "status", clients: 1 });
    expect(failingSocket.closed).toBe(true);
  });

  it("closes connected clients when shutting down", () => {
    const pty = new MockPty();
    const manager = new TerminalManager({ spawnImpl: () => pty as any, logger });
    const socket = new MockSocket();

    manager.attach("session-shutdown", socket as unknown as WebSocket);

    manager.shutdown();

    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(1011);
    expect(socket.closeReason).toBe("terminal session ended");
    expect(pty.killed).toBe(true);
  });
});
