import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import type https from "node:https";

import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { setupWSConnection } from "y-websocket/bin/utils";
import * as Y from "yjs";

import { appLogger, normalizeError } from "../observability/logger.js";
import { normalizeTenantIdInput } from "../tenants/tenantIds.js";

const PERSISTENCE_DIR = path.resolve(process.cwd(), ".collaboration");
const AGENT_EDIT_ORIGIN = "agent_edit";
const COMPACTION_ORIGIN = "compaction";
const ROOM_IDLE_THRESHOLD_MS = 5 * 60 * 1000;
const ROOM_CHECK_INTERVAL_MS = 60 * 1000;

const TEXT_FIELD = "content";

type RoomState = {
  doc: Y.Doc;
  lastUserEditAt: number;
  filePath: string;
  clients: Set<WebSocket>;
};

const rooms = new Map<string, RoomState>();

function ensurePersistenceDir(): Promise<void> {
  return fs.mkdir(PERSISTENCE_DIR, { recursive: true });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.find((entry) => typeof entry === "string" && entry.trim().length > 0)?.trim();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function deriveRoomId(req: IncomingMessage): {
  roomId?: string;
  filePath?: string;
  error?: string;
} {
  const urlValue = req.url;
  if (!urlValue) {
    return { error: "missing request url" };
  }
  let parsed: URL;
  try {
    parsed = new URL(urlValue, "http://localhost");
  } catch (error) {
    return { error: "invalid request url" };
  }
  const tenantId = headerValue(req.headers["x-tenant-id"]);
  const projectId = headerValue(req.headers["x-project-id"]);
  const sessionId = headerValue(req.headers["x-session-id"]);
  const filePath = parsed.searchParams.get("filePath")?.trim();

  if (!tenantId || !projectId || !sessionId || !filePath) {
    return { error: "missing identity or file path" };
  }

  const normalizedTenant = normalizeTenantIdInput(tenantId);
  if (normalizedTenant.error) {
    return { error: normalizedTenant.error.message };
  }

  const key = `${normalizedTenant.tenantId ?? ""}:${projectId}:${sessionId}:${filePath}`;
  const roomId = createHash("sha256").update(key).digest("hex");
  return { roomId, filePath };
}

function getRoomState(roomId: string, filePath: string): RoomState {
  const existing = rooms.get(roomId);
  if (existing) {
    return existing;
  }
  const doc = new Y.Doc();
  const state: RoomState = {
    doc,
    lastUserEditAt: 0,
    filePath,
    clients: new Set<WebSocket>(),
  };
  attachListeners(roomId, state);
  rooms.set(roomId, state);
  return state;
}

function attachListeners(roomId: string, state: RoomState): void {
  state.doc.on("update", (_update, origin) => {
    if (origin === AGENT_EDIT_ORIGIN || origin === COMPACTION_ORIGIN) {
      return;
    }
    state.lastUserEditAt = Date.now();
    appLogger.debug({ roomId }, "collaboration room activity detected");
  });
}

function roomPersistencePath(roomId: string): string {
  return path.join(PERSISTENCE_DIR, `${roomId}.txt`);
}

async function loadRoomFromDisk(roomId: string, state: RoomState): Promise<void> {
  try {
    await ensurePersistenceDir();
    const content = await fs.readFile(roomPersistencePath(roomId), "utf8");
    const text = state.doc.getText(TEXT_FIELD);
    state.doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, content);
    }, COMPACTION_ORIGIN);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      appLogger.warn(
        { err: normalizeError(error), roomId },
        "failed to load collaboration room from disk",
      );
    }
  }
}

async function persistRoom(roomId: string, state: RoomState): Promise<void> {
  const text = state.doc.getText(TEXT_FIELD);
  const content = text.toString();
  await ensurePersistenceDir();
  await fs.writeFile(roomPersistencePath(roomId), content, "utf8");
}

async function compactRoom(roomId: string, state: RoomState): Promise<void> {
  try {
    await persistRoom(roomId, state);
    const nextDoc = new Y.Doc();
    const text = nextDoc.getText(TEXT_FIELD);
    const persisted = await fs.readFile(roomPersistencePath(roomId), "utf8");
    nextDoc.transact(() => {
      text.insert(0, persisted);
    }, COMPACTION_ORIGIN);
    if (state.clients.size > 0) {
      return;
    }
    const existingClients = state.clients;
    state.doc = nextDoc;
    state.clients = existingClients;
    state.lastUserEditAt = 0;
    attachListeners(roomId, state);
    rooms.set(roomId, state);
  } catch (error) {
    appLogger.warn({ err: normalizeError(error), roomId }, "failed to compact collaboration room");
  }
}

function scheduleCompaction(server: http.Server | https.Server): void {
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [roomId, state] of rooms.entries()) {
      if (state.clients.size > 0) {
        continue;
      }
      if (state.lastUserEditAt === 0) {
        continue;
      }
      const idleDuration = now - state.lastUserEditAt;
      if (idleDuration < ROOM_IDLE_THRESHOLD_MS) {
        continue;
      }
      compactRoom(roomId, state).catch((error) => {
        appLogger.warn({ err: normalizeError(error), roomId }, "compaction failed");
      });
    }
  }, ROOM_CHECK_INTERVAL_MS);

  server.on("close", () => clearInterval(interval));
}

export function setupCollaborationServer(httpServer: http.Server | https.Server): void {
  const wss = new WebSocketServer({ noServer: true });
  scheduleCompaction(httpServer);

  httpServer.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "", "http://localhost");
    if (pathname !== "/collaboration/ws") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const derived = deriveRoomId(request);
      if (!derived.roomId || !derived.filePath) {
        ws.close(4401, derived.error ?? "unauthorized");
        return;
      }

      const room = getRoomState(derived.roomId, derived.filePath);
      loadRoomFromDisk(derived.roomId, room)
        .catch((error) => {
          appLogger.warn({ err: normalizeError(error), roomId: derived.roomId }, "failed to hydrate room from disk");
        })
        .finally(() => {
          room.clients.add(ws);
          ws.once("close", () => {
            room.clients.delete(ws);
          });

          setupWSConnection(ws, request, { docName: derived.roomId, gc: true, getYDoc: () => room.doc });
        });
    });
  });
}

export function isRoomBusy(roomId: string, thresholdMs = 5000): boolean {
  const room = rooms.get(roomId);
  if (!room || room.lastUserEditAt === 0) {
    return false;
  }
  return Date.now() - room.lastUserEditAt < thresholdMs;
}

export function applyAgentEditToRoom(roomId: string, filePath: string, newContent: string): Y.Doc {
  const state = getRoomState(roomId, filePath);
  const text = state.doc.getText(TEXT_FIELD);
  state.doc.transact(() => {
    text.delete(0, text.length);
    text.insert(0, newContent);
  }, AGENT_EDIT_ORIGIN);
  return state.doc;
}

// Exported for tests only.
export function getRoomStateForTesting(roomId: string): RoomState | undefined {
  return rooms.get(roomId);
}
