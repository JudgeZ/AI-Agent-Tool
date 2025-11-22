import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

const CLOSE_CODE_UNAUTHORIZED = 4401;
const ALLOWED_ORIGIN = "https://collab.example.com";

vi.mock(
  "y-websocket/bin/utils",
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

vi.mock(
  "y-protocols/awareness.js",
  () => {
    class Awareness {
      constructor(_doc?: unknown) {}
      on(): void {}
      off(): void {}
      destroy(): void {}
      getLocalState(): Record<string, unknown> | null {
        return {};
      }
      getStates(): Map<string, unknown> {
        return new Map();
      }
      setLocalState(_state: unknown): void {}
      setLocalStateField(_field: string, _value: unknown): void {}
    }
    return { Awareness };
  },
  { virtual: true },
);

vi.mock(
  "lib0/mutex.js",
  () => ({ createMutex: () => (fn: () => void) => fn() }),
  { virtual: true },
);

vi.mock("../observability/audit.js", () => {
  const logAuditEvent = vi.fn();
  return { logAuditEvent, hashIdentifier: (value: string) => `hashed:${value}` };
});

import {
  applyAgentEditToRoom,
  getRoomStateForTesting,
  getTrackedIpsForTesting,
  getTrackedIpCountForTesting,
  isRoomBusy,
  resetIpConnectionCountsForTesting,
  runRoomMaintenanceForTesting,
  setupCollaborationServer,
} from "./index.js";
import { DEFAULT_CONFIG } from "../config/loadConfig.js";
import { sessionStore } from "../auth/SessionStore.js";
import { logAuditEvent } from "../observability/audit.js";
import { normalizeTenantIdInput } from "../tenants/tenantIds.js";

describe("persistence directory validation", () => {
  it("rejects insecure persistence directory permissions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "collab-insecure-"));
    await fs.chmod(tempDir, 0o777);
    const originalDir = process.env.COLLAB_PERSISTENCE_DIR;
    const server = http.createServer();
    try {
      const config = structuredClone(DEFAULT_CONFIG);
      process.env.COLLAB_PERSISTENCE_DIR = tempDir;
      await expect(setupCollaborationServer(server, config)).rejects.toThrow(
        /persistence directory permissions/i,
      );
    } finally {
      if (originalDir === undefined) {
        delete process.env.COLLAB_PERSISTENCE_DIR;
      } else {
        process.env.COLLAB_PERSISTENCE_DIR = originalDir;
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails fast when persistence directory cannot be created", async () => {
    const statSpy = vi
      .spyOn(fs, "lstat")
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const mkdirSpy = vi
      .spyOn(fs, "mkdir")
      .mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    const server = http.createServer();
    const config = structuredClone(DEFAULT_CONFIG);

    try {
      await expect(setupCollaborationServer(server, config)).rejects.toThrow(
        /failed to prepare collaboration persistence directory/i,
      );
    } finally {
      mkdirSpy.mockRestore();
      statSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function createSessionHeaders({
  tenantId = "tenant-a",
  projectId = "project-a",
  sessionHeaderId,
  includeOrigin = true,
  claims = {},
}: {
  tenantId?: string;
  projectId?: string;
  sessionHeaderId?: string;
  includeOrigin?: boolean;
  claims?: Record<string, unknown>;
} = {}) {
  const session = sessionStore.createSession(
    {
      subject: `user-${tenantId}`,
      tenantId,
      roles: [],
      scopes: [],
      claims,
    },
    DEFAULT_CONFIG.auth.oidc.session.ttlSeconds,
  );

  return {
    authorization: `Bearer ${session.id}`,
    Cookie: `${DEFAULT_CONFIG.auth.oidc.session.cookieName}=${session.id}`,
    "x-tenant-id": tenantId,
    "x-project-id": projectId,
    "x-session-id": sessionHeaderId ?? session.id,
    ...(includeOrigin ? { Origin: ALLOWED_ORIGIN } : {}),
  } as Record<string, string>;
}

describe("collaboration server", () => {
  let server: http.Server;
  let port: number;
  const originalIpLimit = process.env.COLLAB_WS_IP_LIMIT;
  const originalRoomLimit = process.env.COLLAB_MAX_ROOMS;

  beforeAll(async () => {
    process.env.COLLAB_WS_IP_LIMIT = "1";
    server = http.createServer();
    const config = structuredClone(DEFAULT_CONFIG);
    config.server.cors.allowedOrigins = [ALLOWED_ORIGIN];
    config.server.trustedProxyCidrs = ["127.0.0.1/32"];
    await setupCollaborationServer(server, config);
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
    vi.mocked(logAuditEvent).mockClear();
    resetIpConnectionCountsForTesting();
    process.env.COLLAB_MAX_ROOMS = originalRoomLimit;
  });

  afterAll(async () => {
    process.env.COLLAB_WS_IP_LIMIT = originalIpLimit;
    process.env.COLLAB_MAX_ROOMS = originalRoomLimit;
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
    const client = new WebSocket(`ws://127.0.0.1:${port}/collaboration/ws?filePath=test.txt`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });

    const error = await new Promise<Error>((resolve) => {
      client.on("error", (err) => resolve(err as Error));
    });

    expect(error.message).toContain("401");
    client.close();
  });

  it("rejects connections without a valid session", async () => {
    const auditSpy = vi.mocked(logAuditEvent);
    auditSpy.mockClear();
    const headers = {
      "x-tenant-id": "tenant-auth-missing",
      "x-project-id": "project-auth-missing",
      "x-session-id": "session-auth-missing",
      authorization: `Bearer ${randomUUID()}`,
      Cookie: `${DEFAULT_CONFIG.auth.oidc.session.cookieName}=${randomUUID()}`,
      Origin: ALLOWED_ORIGIN,
    };

    const client = new WebSocket(
      `ws://127.0.0.1:${port}/collaboration/ws?filePath=missing-session.txt`,
      { headers },
    );

    const error = await new Promise<Error>((resolve) => {
      client.on("error", (err) => resolve(err as Error));
    });

    expect(error.message).toContain("401");
    expect(
      auditSpy.mock.calls.some(
        ([event]) =>
          event.action === "collaboration.connection" &&
          event.outcome === "denied" &&
          event.details?.reason === "unknown session",
      ),
    ).toBe(true);
    client.close();
  });

  it("rejects connections when project is not authorized in the session claims", async () => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/collaboration/ws?filePath=unauthorized.txt`, {
      headers: createSessionHeaders({
        projectId: "project-not-allowed",
        claims: { projects: ["project-allowed"] },
      }),
    });

    const result = await new Promise<{ error?: Error; closeCode?: number }>((resolve) => {
      client.on("error", (err) => resolve({ error: err as Error }));
      client.on("close", (code) => resolve({ closeCode: code }));
    });

    expect(result.closeCode).toBe(CLOSE_CODE_UNAUTHORIZED);
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
    const auditSpy = vi.mocked(logAuditEvent);
    auditSpy.mockClear();
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
    expect(
      auditSpy.mock.calls.some(
        ([event]) =>
          event.action === "collaboration.connection" &&
          event.outcome === "denied" &&
          event.details?.reason === "ip_rate_limited",
      ),
    ).toBe(true);
    await new Promise<void>((resolve) => {
      first.on("close", () => resolve());
      first.close();
    });
  });

  it("uses forwarded client IPs from trusted proxies for per-IP limiting", async () => {
    const headers = createSessionHeaders({ tenantId: "tenant-forwarded", projectId: "project-forwarded" });

    const first = new WebSocket(`ws://127.0.0.1:${port}/collaboration/ws?filePath=forwarded.txt`, {
      headers: { ...headers, "x-forwarded-for": "198.51.100.10" },
    });
    await new Promise<void>((resolve, reject) => {
      first.on("open", () => resolve());
      first.on("error", (error) => reject(error));
    });

    const second = new WebSocket(`ws://127.0.0.1:${port}/collaboration/ws?filePath=forwarded.txt`, {
      headers: { ...headers, "x-forwarded-for": "198.51.100.11" },
    });

    await new Promise<void>((resolve, reject) => {
      second.on("open", () => resolve());
      second.on("error", (error) => reject(error));
    });

    await new Promise<void>((resolve) => {
      first.on("close", () => resolve());
      first.close();
    });
    await new Promise<void>((resolve) => {
      second.on("close", () => resolve());
      second.close();
    });
  });

  it("cleans up per-IP connection tracking after connections close", async () => {
    const headers = createSessionHeaders({ tenantId: "tenant-cleanup", projectId: "project-cleanup" });

    const first = new WebSocket(`ws://127.0.0.1:${port}/collaboration/ws?filePath=cleanup.txt`, { headers });
    await new Promise<void>((resolve, reject) => {
      first.on("open", () => resolve());
      first.on("error", (error) => reject(error));
    });

    expect(getTrackedIpCountForTesting()).toBe(1);

    await new Promise<void>((resolve) => {
      first.on("close", () => resolve());
      first.close();
    });

    expect(getTrackedIpsForTesting()).toEqual([]);

    const second = new WebSocket(`ws://127.0.0.1:${port}/collaboration/ws?filePath=cleanup.txt`, { headers });

    await new Promise<void>((resolve, reject) => {
      second.on("open", () => resolve());
      second.on("error", (error) => reject(error));
    });

    expect(getTrackedIpCountForTesting()).toBe(1);

    await new Promise<void>((resolve) => {
      second.on("close", () => resolve());
      second.close();
    });

    expect(getTrackedIpsForTesting()).toEqual([]);
  });

  it("rejects new rooms when the configured room limit is reached", async () => {
    const first = new WebSocket(`ws://127.0.0.1:${port}/collaboration/ws?filePath=first.txt`, {
      headers: createSessionHeaders({
        tenantId: "tenant-room-limit",
        projectId: "project-room-limit",
      }),
    });
    await new Promise<void>((resolve) => first.once("open", () => resolve()));

    process.env.COLLAB_MAX_ROOMS = "1";

    await new Promise<void>((resolve) => {
      first.on("close", () => resolve());
      first.close();
    });

    const second = new WebSocket(`ws://127.0.0.1:${port}/collaboration/ws?filePath=second.txt`, {
      headers: createSessionHeaders({
        tenantId: "tenant-room-limit",
        projectId: "project-room-limit",
      }),
    });

    const result = await new Promise<{ error?: Error; closeCode?: number }>((resolve) => {
      second.on("error", (err) => resolve({ error: err as Error }));
      second.on("close", (code) => resolve({ closeCode: code }));
    });

    expect(result.closeCode).toBe(1013);
    second.close();
  });

  it("ignores spoofed X-Real-IP headers for per-IP limiting", async () => {
    const auditSpy = vi.mocked(logAuditEvent);
    auditSpy.mockClear();
    const headers = createSessionHeaders({ tenantId: "tenant-spoof", projectId: "project-spoof" });

    const first = new WebSocket(`ws://127.0.0.1:${port}/collaboration/ws?filePath=limited.txt`, {
      headers: { ...headers, "x-real-ip": "203.0.113.10" },
    });
    await new Promise<void>((resolve) => {
      first.on("open", () => resolve());
    });

    const second = new WebSocket(`ws://127.0.0.1:${port}/collaboration/ws?filePath=limited.txt`, {
      headers: { ...headers, "x-real-ip": "198.51.100.5" },
    });

    const error = await new Promise<Error>((resolve) => {
      second.on("error", (err) => resolve(err as Error));
    });

    expect(error.message).toContain("429");
    expect(
      auditSpy.mock.calls.some(
        ([event]) =>
          event.action === "collaboration.connection" &&
          event.outcome === "denied" &&
          event.details?.reason === "ip_rate_limited",
      ),
    ).toBe(true);

    await new Promise<void>((resolve) => {
      first.on("close", () => resolve());
      first.close();
    });
  });

  it("allows authenticated clients to connect", async () => {
    const auditSpy = vi.mocked(logAuditEvent);
    auditSpy.mockClear();
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
    expect(
      auditSpy.mock.calls.some(
        ([event]) =>
          event.action === "collaboration.connection" &&
          event.outcome === "success" &&
          typeof event.details?.roomId === "string",
      ),
    ).toBe(true);
  });

  it("reuses room ids for the same tenant, project, and file across sessions", async () => {
    const auditSpy = vi.mocked(logAuditEvent);
    auditSpy.mockClear();
    const filePath = "shared-room.txt";

    const connectAndClose = (headers: Record<string, string>) =>
      new Promise<void>((resolve, reject) => {
        const client = new WebSocket(
          `ws://127.0.0.1:${port}/collaboration/ws?filePath=${filePath}`,
          { headers },
        );

        const timer = setTimeout(() => {
          client.close();
          resolve();
        }, 2000);

        client.on("open", () => {
          client.close();
        });
        client.on("close", () => {
          clearTimeout(timer);
          resolve();
        });
        client.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

    await connectAndClose(createSessionHeaders({ tenantId: "tenant-shared", projectId: "project-shared" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await connectAndClose(createSessionHeaders({ tenantId: "tenant-shared", projectId: "project-shared" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const normalizedTenant = normalizeTenantIdInput("tenant-shared");
    const expectedKey = createHash("sha256")
      .update(`${normalizedTenant.tenantId}:project-shared:${filePath}`)
      .digest("hex");

    expect(getRoomStateForTesting(expectedKey)).toBeDefined();
    expect(getTrackedIpCountForTesting()).toBe(0);
  });

  it("preserves active room state instead of reloading stale snapshots", async () => {
    const roomId = "stale-room";
    const filePath = "stale-room.txt";
    const originalDir = process.env.COLLAB_PERSISTENCE_DIR;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "collab-stale-"));
    const headers = createSessionHeaders({ tenantId: "tenant-stale", projectId: "project-stale" });

    try {
      process.env.COLLAB_PERSISTENCE_DIR = tempDir;
      applyAgentEditToRoom(roomId, filePath, "live edits");
      await fs.writeFile(path.join(tempDir, `${roomId}.txt`), "persisted snapshot", "utf8");

      await new Promise<void>((resolve, reject) => {
        const client = new WebSocket(
          `ws://127.0.0.1:${port}/collaboration/ws?filePath=${filePath}`,
          { headers },
        );

        client.on("open", () => client.close());
        client.on("close", () => resolve());
        client.on("error", (error) => reject(error));
      });

      const room = getRoomStateForTesting(roomId);
      expect(room?.doc.getText("content").toString()).toBe("live edits");
    } finally {
      if (originalDir === undefined) {
        delete process.env.COLLAB_PERSISTENCE_DIR;
      } else {
        process.env.COLLAB_PERSISTENCE_DIR = originalDir;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
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

  it("rejects connections from disallowed origins when configured", async () => {
    const headers = createSessionHeaders();
    const client = new WebSocket(
      `ws://127.0.0.1:${port}/collaboration/ws?filePath=origin.txt`,
      { headers: { ...headers, Origin: "https://evil.example.com" } },
    );

    const error = await new Promise<Error>((resolve) => {
      client.on("error", (err) => resolve(err as Error));
    });

    expect(error.message).toContain("403");
    client.close();
  });

  it("rejects connections without an origin when allowlist is configured", async () => {
    const headers = createSessionHeaders({ includeOrigin: false });
    const client = new WebSocket(
      `ws://127.0.0.1:${port}/collaboration/ws?filePath=missing-origin.txt`,
      { headers },
    );

    const error = await new Promise<Error>((resolve) => {
      client.on("error", (err) => resolve(err as Error));
    });

    expect(error.message).toContain("403");
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
