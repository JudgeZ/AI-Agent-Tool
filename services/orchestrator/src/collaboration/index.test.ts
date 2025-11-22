import http from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

vi.mock(
  "y-websocket/bin/utils.js",
  () => ({
    setupWSConnection: vi.fn(),
  }),
  { virtual: true },
);

vi.mock(
  "yjs",
  () => {
    class Text {
      value = "";

      get length(): number {
        return this.value.length;
      }

      delete(start: number, length: number): void {
        this.value = this.value.slice(0, start) + this.value.slice(start + length);
      }

      insert(start: number, text: string): void {
        this.value = this.value.slice(0, start) + text + this.value.slice(start);
      }

      toString(): string {
        return this.value;
      }
    }

    class Doc {
      private texts = new Map<string, Text>();
      private listeners: Array<(update: unknown, origin?: unknown) => void> = [];

      getText(name: string): Text {
        if (!this.texts.has(name)) {
          this.texts.set(name, new Text());
        }
        return this.texts.get(name)!;
      }

      transact(fn: () => void, origin?: unknown): void {
        fn();
        this.listeners.forEach((listener) => listener(undefined, origin));
      }

      on(event: string, listener: (update: unknown, origin?: unknown) => void): void {
        if (event === "update") {
          this.listeners.push(listener);
        }
      }
    }

    return { Doc };
  },
  { virtual: true },
);

import {
  applyAgentEditToRoom,
  getRoomStateForTesting,
  isRoomBusy,
  runRoomMaintenanceForTesting,
  setupCollaborationServer,
} from "./index.js";

describe("collaboration server", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    vi.useFakeTimers();
    server = http.createServer();
    setupCollaborationServer(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (typeof address === "object" && address?.port) {
          port = address.port;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  it("rejects connections without identity headers", async () => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/collaboration/ws?filePath=test.txt`);

    const code = await new Promise<number>((resolve) => {
      client.on("close", (closeCode) => resolve(closeCode));
    });

    expect(code).toBe(4401);
  });

  it("enforces per-IP connection limits", async () => {
    const originalIpLimit = process.env.COLLAB_WS_IP_LIMIT;
    try {
      process.env.COLLAB_WS_IP_LIMIT = "1";
      const headers = {
        "x-tenant-id": "tenant-limit",
        "x-project-id": "project-limit",
        "x-session-id": "session-limit",
      };

      const first = new WebSocket(`ws://127.0.0.1:${port}/collaboration/ws?filePath=limited.txt`, { headers });
      await new Promise<void>((resolve) => {
        first.on("open", () => resolve());
      });

      const second = new WebSocket(`ws://127.0.0.1:${port}/collaboration/ws?filePath=limited.txt`, { headers });

      const error = await new Promise<Error>((resolve) => {
        second.on("error", (err) => resolve(err as Error));
      });

      expect(error.message).toContain("429");
      first.close();
    } finally {
      process.env.COLLAB_WS_IP_LIMIT = originalIpLimit;
    }
  });

  it("allows authenticated clients to connect", async () => {
    const client = new WebSocket(
      `ws://127.0.0.1:${port}/collaboration/ws?filePath=connected.txt`,
      {
        headers: {
          "x-tenant-id": "tenant-a",
          "x-project-id": "project-a",
          "x-session-id": "session-a",
        },
      },
    );

    await new Promise<void>((resolve, reject) => {
      client.on("open", () => resolve());
      client.on("error", (error) => reject(error));
    });

    client.close();
  });

  it("tracks busy rooms only for human edits", () => {
    const roomId = "room-busy-check";
    const doc = applyAgentEditToRoom(roomId, "room-busy-check.txt", "initial");

    expect(isRoomBusy(roomId)).toBe(false);

    const text = doc.getText("content");
    doc.transact(() => {
      text.insert(text.length, " human");
    }, "human_edit");

    expect(isRoomBusy(roomId, 10000)).toBe(true);
    const state = getRoomStateForTesting(roomId);
    expect(state?.doc).toBe(doc);
  });

  it("evicts idle rooms after persistence", async () => {
    const roomId = "eviction-room";
    applyAgentEditToRoom(roomId, "eviction-room.txt", "start");
    const state = getRoomStateForTesting(roomId);
    expect(state).toBeDefined();
    const now = Date.now();
    state!.lastUserEditAt = now - 16 * 60 * 1000;

    await runRoomMaintenanceForTesting();

    expect(getRoomStateForTesting(roomId)).toBeUndefined();
  });
});
