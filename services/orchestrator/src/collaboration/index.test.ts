import http from "node:http";
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

const CLOSE_CODE_UNAUTHORIZED = 4401;

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
import { DEFAULT_CONFIG } from "../config/loadConfig.js";
import { sessionStore } from "../auth/SessionStore.js";

function createSessionHeaders({
  tenantId = "tenant-a",
  projectId = "project-a",
  sessionHeaderId,
}: {
  tenantId?: string;
  projectId?: string;
  sessionHeaderId?: string;
} = {}) {
  const session = sessionStore.createSession(
    {
      subject: `user-${tenantId}`,
      tenantId,
      roles: [],
      scopes: [],
      claims: {},
    },
    DEFAULT_CONFIG.auth.oidc.session.ttlSeconds,
  );

  return {
    authorization: `Bearer ${session.id}`,
    Cookie: `${DEFAULT_CONFIG.auth.oidc.session.cookieName}=${session.id}`,
    "x-tenant-id": tenantId,
    "x-project-id": projectId,
    "x-session-id": sessionHeaderId ?? session.id,
  } as Record<string, string>;
}

describe("collaboration server", () => {
  let server: http.Server;
  let port: number;
  const originalIpLimit = process.env.COLLAB_WS_IP_LIMIT;

  beforeAll(async () => {
    vi.useFakeTimers();
    process.env.COLLAB_WS_IP_LIMIT = "1";
    server = http.createServer();
    setupCollaborationServer(server, DEFAULT_CONFIG);
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

  afterEach(() => {
    sessionStore.clear();
  });

  afterAll(async () => {
    process.env.COLLAB_WS_IP_LIMIT = originalIpLimit;
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

    const error = await new Promise<Error>((resolve) => {
      client.on("error", (err) => resolve(err as Error));
    });

    expect(error.message).toContain("401");
    client.close();
  });

  it("rejects connections without a valid session", async () => {
    const headers = {
      "x-tenant-id": "tenant-auth-missing",
      "x-project-id": "project-auth-missing",
      "x-session-id": "session-auth-missing",
      authorization: `Bearer ${randomUUID()}`,
      Cookie: `${DEFAULT_CONFIG.auth.oidc.session.cookieName}=${randomUUID()}`,
    };

    const client = new WebSocket(
      `ws://127.0.0.1:${port}/collaboration/ws?filePath=missing-session.txt`,
      { headers },
    );

    const error = await new Promise<Error>((resolve) => {
      client.on("error", (err) => resolve(err as Error));
    });

    expect(error.message).toContain("401");
    client.close();
  });

  it("rejects connections when header session id does not match authenticated session", async () => {
    const headers = createSessionHeaders();
    headers["x-session-id"] = randomUUID();

    const client = new WebSocket(`ws://127.0.0.1:${port}/collaboration/ws?filePath=header-mismatch.txt`, { headers });

    const result = await new Promise<{ error?: Error; closeCode?: number }>((resolve) => {
      client.on("error", (err) => resolve({ error: err as Error }));
      client.on("close", (code) => resolve({ closeCode: code }));
    });

    const message = result.error?.message ?? "";
    expect(message.includes("401") || result.closeCode === CLOSE_CODE_UNAUTHORIZED).toBe(true);
    client.close();
  });

  it("enforces per-IP connection limits", async () => {
    const headers = createSessionHeaders({ tenantId: "tenant-limit", projectId: "project-limit" });

    const first = new WebSocket(`ws://127.0.0.1:${port}/collaboration/ws?filePath=limited.txt`, { headers });
    await new Promise<void>((resolve) => {
      first.on("open", () => resolve());
    });

    const second = new WebSocket(`ws://127.0.0.1:${port}/collaboration/ws?filePath=limited.txt`, { headers });

    const error = await new Promise<Error>((resolve) => {
      second.on("error", (err) => resolve(err as Error));
    });

    expect(error.message).toContain("429");
    await new Promise<void>((resolve) => {
      first.on("close", () => resolve());
      first.close();
    });
  });

  it("allows authenticated clients to connect", async () => {
    const headers = createSessionHeaders();
    const client = new WebSocket(
      `ws://127.0.0.1:${port}/collaboration/ws?filePath=connected.txt`,
      { headers },
    );

    await new Promise<void>((resolve, reject) => {
      client.on("open", () => resolve());
      client.on("error", (error) => reject(error));
    });

    await new Promise<void>((resolve) => {
      client.on("close", () => resolve());
      client.close();
    });
  });

  it("rejects path traversal attempts", async () => {
    const headers = createSessionHeaders();
    const client = new WebSocket(
      `ws://127.0.0.1:${port}/collaboration/ws?filePath=../../etc/passwd`,
      { headers },
    );

    const result = await new Promise<{ error?: Error; closeCode?: number }>((resolve) => {
      client.on("error", (err) => resolve({ error: err as Error }));
      client.on("close", (code) => resolve({ closeCode: code }));
    });

    const message = result.error?.message ?? "";
    expect(message.includes("401") || result.closeCode === CLOSE_CODE_UNAUTHORIZED).toBe(true);
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
