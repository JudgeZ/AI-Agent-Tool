import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import type https from "node:https";

import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
// setupWSConnection is imported from a y-websocket internal module; monitor for upstream API changes.
import { setupWSConnection } from "y-websocket/bin/utils";
import { z } from "zod";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness.js";
import { createMutex } from "lib0/mutex.js";

import type { AppConfig } from "../config.js";
import { SessionRecord, sessionStore } from "../auth/SessionStore.js";
import { validateSessionId, type SessionExtractionResult, type SessionSource } from "../auth/sessionValidation.js";
import { hashIdentifier, logAuditEvent } from "../observability/audit.js";
import { appLogger, normalizeError } from "../observability/logger.js";
import { normalizeTenantIdInput } from "../tenants/tenantIds.js";

const DEFAULT_PERSISTENCE_DIR = ".collaboration";
const AGENT_EDIT_ORIGIN = "agent_edit";
const COMPACTION_ORIGIN = "compaction";
const ROOM_IDLE_THRESHOLD_MS = 5 * 60 * 1000;
const ROOM_EVICTION_THRESHOLD_MS = 15 * 60 * 1000;
const ROOM_CHECK_INTERVAL_MS = 60 * 1000;
const MAX_WS_PAYLOAD_BYTES = 1024 * 1024;
const CLOSE_CODE_UNAUTHORIZED = 4401;
const MAX_ROOMS_DEFAULT = 500;

const TEXT_FIELD = "content";

const collabIdentitySchema = z.object({
  tenantId: z.string().trim().min(1).max(256),
  projectId: z.string().trim().regex(/^[A-Za-z0-9._-]{1,128}$/),
  sessionId: z.string().trim().regex(/^[A-Za-z0-9._-]{1,128}$/),
  filePath: z
    .string()
    .trim()
    .max(4096)
    .refine((value) => !value.includes("\x00"), { message: "invalid file path" })
    .refine((value) => !value.startsWith("/"), { message: "invalid file path" })
    .refine((value) => !value.includes(".."), { message: "invalid file path" }),
});

class CollabDoc extends Y.Doc {
  name: string;
  mux = createMutex();
  awareness = new Awareness(this);

  constructor(name: string) {
    super({ gc: false });
    this.name = name;
  }
}

type RoomState = {
  doc: CollabDoc;
  lastUserEditAt: number;
  lastCompactionAt: number;
  filePath: string;
  createdAt: number;
  clients: Set<WebSocket>;
};

const rooms = new Map<string, RoomState>();
const ipConnectionCounts = new Map<string, number>();

function resolvePersistenceDir(): string {
  const rawDir = process.env.COLLAB_PERSISTENCE_DIR ?? DEFAULT_PERSISTENCE_DIR;
  if (rawDir.includes("\0")) {
    throw new Error("collaboration persistence directory contains invalid null byte");
  }
  return path.resolve(process.cwd(), rawDir);
}

function validatePersistenceDir(persistenceDir: string): void {
  const rootPath = path.parse(persistenceDir).root;
  if (persistenceDir === rootPath) {
    throw new Error("collaboration persistence directory must not be the filesystem root");
  }
  if (!persistenceDir.startsWith(process.cwd()) && !path.isAbsolute(persistenceDir)) {
    throw new Error("collaboration persistence directory must be an absolute path");
  }
}

async function ensurePersistenceDir(): Promise<void> {
  const persistenceDir = resolvePersistenceDir();
  validatePersistenceDir(persistenceDir);
  try {
    const stats = await fs.lstat(persistenceDir);
    if (stats.isSymbolicLink()) {
      throw new Error("collaboration persistence directory must not be a symlink");
    }
    if (!stats.isDirectory()) {
      throw new Error("collaboration persistence path must be a directory");
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new Error("collaboration persistence directory permissions are too broad; use 0700");
    }
    await fs.access(persistenceDir, fsConstants.W_OK);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`failed to prepare collaboration persistence directory: ${(error as Error).message}`);
    }
  }

  try {
    await fs.mkdir(persistenceDir, { recursive: true, mode: 0o700 });
    await fs.access(persistenceDir, fsConstants.W_OK);
  } catch (error) {
    throw new Error(`failed to prepare collaboration persistence directory: ${(error as Error).message}`);
  }
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

function clientIp(req: IncomingMessage): string {
  if (req.socket.remoteAddress) {
    return req.socket.remoteAddress;
  }
  return "unknown";
}

function resolveConnectionLimitFromEnv(): number {
  const parsed = Number.parseInt(process.env.COLLAB_WS_IP_LIMIT ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 12;
}

function resolveRoomLimitFromEnv(): number {
  const parsed = Number.parseInt(process.env.COLLAB_MAX_ROOMS ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return MAX_ROOMS_DEFAULT;
}

function requestIdentifiers(req: IncomingMessage): {
  requestId?: string;
  traceId?: string;
} {
  return {
    requestId: headerValue(req.headers["x-request-id"]),
    traceId: headerValue(req.headers["x-trace-id"]),
  };
}

function sanitizeHeaderForLog(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/\r|\n/g, "").slice(0, 512);
}

function auditSubjectFromSession(session: SessionRecord | undefined) {
  if (!session) {
    return undefined;
  }
  return {
    sessionId: session.id,
    userId: session.subject,
    tenantId: session.tenantId ?? undefined,
    email: session.email ?? undefined,
  };
}

function incrementConnection(ip: string, limit: number): boolean {
  const current = ipConnectionCounts.get(ip) ?? 0;
  if (current >= limit) {
    return false;
  }
  ipConnectionCounts.set(ip, current + 1);
  return true;
}

function decrementConnection(ip: string): void {
  const current = ipConnectionCounts.get(ip) ?? 0;
  if (current <= 1) {
    ipConnectionCounts.delete(ip);
    return;
  }
  ipConnectionCounts.set(ip, current - 1);
}

function extractSessionIdFromUpgrade(
  req: IncomingMessage,
  cookieName: string,
): SessionExtractionResult {
  const authHeader = headerValue(req.headers.authorization);
  const bearerPrefix = "bearer ";
  if (authHeader && authHeader.toLowerCase().startsWith(bearerPrefix)) {
    const token = authHeader.slice(bearerPrefix.length).trim();
    return validateSessionId(token, "authorization");
  }

  const cookieHeader = headerValue(req.headers.cookie);
  if (!cookieHeader) {
    return { status: "missing" };
  }

  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rest] = part.split("=");
    if (!rawName) {
      continue;
    }
    const name = rawName.trim();
    if (name !== cookieName) {
      continue;
    }
    const rawValue = rest.join("=");
    const trimmedValue = rawValue.trim();
    let decoded = trimmedValue;
    try {
      decoded = decodeURIComponent(trimmedValue);
    } catch {
      // Preserve raw value so validation can surface helpful errors.
    }
    return validateSessionId(decoded, "cookie");
  }

  return { status: "missing" };
}

function authenticateCollaborationRequest(
  req: IncomingMessage,
  cookieName: string,
):
  | { status: "ok"; session: SessionRecord; sessionId: string; source?: SessionSource }
  | { status: "error"; reason: string; source?: SessionSource } {
  sessionStore.cleanupExpired();
  const sessionResult = extractSessionIdFromUpgrade(req, cookieName);
  if (sessionResult.status === "invalid") {
    return { status: "error", reason: "invalid session", source: sessionResult.source };
  }
  if (sessionResult.status === "missing") {
    return { status: "error", reason: "missing session" };
  }
  const session = sessionStore.getSession(sessionResult.sessionId);
  if (!session) {
    return { status: "error", reason: "unknown session", source: sessionResult.source };
  }
  return { status: "ok", session, sessionId: sessionResult.sessionId, source: sessionResult.source };
}

function loggerWithTrace(req: IncomingMessage) {
  const traceId = headerValue(req.headers["x-trace-id"]) ?? headerValue(req.headers["x-request-id"]);
  if (!traceId) {
    return appLogger;
  }
  return appLogger.child({ trace_id: traceId });
}

function deriveRoomId(
  req: IncomingMessage,
  validatedSession: SessionRecord,
  validatedSessionId: string,
): {
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
  const identity = collabIdentitySchema.safeParse({
    tenantId: headerValue(req.headers["x-tenant-id"]),
    projectId: headerValue(req.headers["x-project-id"]),
    sessionId: headerValue(req.headers["x-session-id"]),
    filePath: parsed.searchParams.get("filePath"),
  });
  if (!identity.success) {
    return { error: "missing identity or file path" };
  }
  const { tenantId, projectId, sessionId, filePath } = identity.data;

  if (sessionId !== validatedSessionId) {
    return { error: "session mismatch" };
  }

  if (validatedSession.tenantId && tenantId !== validatedSession.tenantId) {
    return { error: "tenant mismatch" };
  }

  const normalizedPath = path.normalize(filePath).replace(/\\/g, "/");
  if (normalizedPath.includes("..") || path.isAbsolute(normalizedPath)) {
    return { error: "invalid file path" };
  }

  const persistenceDir = resolvePersistenceDir();
  const resolvedPath = path.resolve(persistenceDir, normalizedPath);
  if (!resolvedPath.startsWith(persistenceDir + path.sep)) {
    return { error: "invalid file path" };
  }

  const idPattern = /^[A-Za-z0-9._-]{1,128}$/;
  if (!idPattern.test(projectId) || !idPattern.test(sessionId)) {
    return { error: "invalid project or session id" };
  }

  const normalizedTenant = normalizeTenantIdInput(tenantId);
  if (normalizedTenant.error) {
    return { error: normalizedTenant.error.message };
  }

  if (!normalizedTenant.tenantId) {
    return { error: "invalid tenant id" };
  }

  const allowedProjects = normalizedSessionProjects(validatedSession.claims);
  if (allowedProjects && !allowedProjects.has(projectId)) {
    return { error: "project mismatch" };
  }

  const key = `${normalizedTenant.tenantId}:${projectId}:${normalizedPath}`;
  const roomId = createHash("sha256").update(key).digest("hex");
  return { roomId, filePath };
}

function normalizedSessionProjects(claims: Record<string, unknown>): Set<string> | null {
  const candidate = claims?.projects ?? claims?.projectIds;
  if (!Array.isArray(candidate)) {
    return null;
  }
  const normalized = candidate
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (normalized.length === 0) {
    return null;
  }
  return new Set(normalized);
}

function getRoomState(roomId: string, filePath: string): RoomState {
  const existing = rooms.get(roomId);
  if (existing) {
    return existing;
  }
  const doc = new CollabDoc(roomId);
  const state: RoomState = {
    doc,
    lastUserEditAt: 0,
    lastCompactionAt: 0,
    filePath,
    createdAt: Date.now(),
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
  return path.join(resolvePersistenceDir(), `${roomId}.txt`);
}

async function loadRoomFromDisk(roomId: string, state: RoomState, logger = appLogger): Promise<void> {
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
      logger.warn({ err: normalizeError(error), roomId }, "failed to load collaboration room from disk");
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
    if (state.clients.size > 0) {
      return;
    }
    await persistRoom(roomId, state);
    if (state.clients.size > 0) {
      return;
    }
    const nextDoc = new CollabDoc(roomId);
    const text = nextDoc.getText(TEXT_FIELD);
    const persisted = await fs.readFile(roomPersistencePath(roomId), "utf8");
    nextDoc.transact(() => {
      text.insert(0, persisted);
    }, COMPACTION_ORIGIN);
    if (state.clients.size > 0) {
      return;
    }
    state.doc = nextDoc;
    state.lastCompactionAt = Date.now();
    attachListeners(roomId, state);
    rooms.set(roomId, state);
  } catch (error) {
    appLogger.warn({ err: normalizeError(error), roomId }, "failed to compact collaboration room");
  }
}

async function evictRoom(roomId: string, state: RoomState): Promise<void> {
  try {
    await persistRoom(roomId, state);
  } catch (error) {
    appLogger.warn({ err: normalizeError(error), roomId }, "failed to persist collaboration room before eviction");
  }

  if (state.clients.size > 0) {
    appLogger.info({ roomId }, "eviction aborted: clients connected");
    return;
  }

  rooms.delete(roomId);
  appLogger.info({ roomId }, "evicted idle collaboration room");
}

async function scanRooms(now = Date.now()): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (const [roomId, state] of rooms.entries()) {
    if (state.clients.size > 0) {
      continue;
    }
    if (state.lastUserEditAt === 0 && now - state.createdAt < ROOM_EVICTION_THRESHOLD_MS) {
      continue;
    }
    const idleDuration = now - state.lastUserEditAt;
    if (idleDuration >= ROOM_EVICTION_THRESHOLD_MS) {
      tasks.push(
        evictRoom(roomId, state).catch((error) => {
          appLogger.warn({ err: normalizeError(error), roomId }, "eviction failed");
        }),
      );
      continue;
    }
    if (idleDuration < ROOM_IDLE_THRESHOLD_MS) {
      continue;
    }
    if (state.lastCompactionAt >= state.lastUserEditAt) {
      continue;
    }
    tasks.push(
      compactRoom(roomId, state).catch((error) => {
        appLogger.warn({ err: normalizeError(error), roomId }, "compaction failed");
      }),
    );
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
  }
}

function scheduleCompaction(server: http.Server | https.Server): void {
  const interval = setInterval(() => {
    scanRooms().catch((error) => {
      appLogger.warn({ err: normalizeError(error) }, "room maintenance failed");
    });
  }, ROOM_CHECK_INTERVAL_MS);

  server.on("close", () => clearInterval(interval));
}

export async function setupCollaborationServer(
  httpServer: http.Server | https.Server,
  config: AppConfig,
): Promise<void> {
  await ensurePersistenceDir();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });
  scheduleCompaction(httpServer);
  const sessionCookieName = config.auth.oidc.session.cookieName;
  const connectionLimitPerIp = resolveConnectionLimitFromEnv();
  const allowedOrigins = new Set(config.server.cors.allowedOrigins ?? []);

  httpServer.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "", "http://localhost");
    if (pathname !== "/collaboration/ws") {
      socket.destroy();
      return;
    }

    const logger = loggerWithTrace(request);
    const identifiers = requestIdentifiers(request);
    const ip = clientIp(request);
    const hashedIp = hashIdentifier(ip);
    const origin = headerValue(request.headers["origin"]);
    if (allowedOrigins.size > 0) {
      let originDenialReason: "origin_missing" | "origin_not_allowed" | null = null;
      if (!origin) {
        originDenialReason = "origin_missing";
      } else if (!allowedOrigins.has(origin)) {
        originDenialReason = "origin_not_allowed";
      }

      if (originDenialReason) {
        const safeOrigin = sanitizeHeaderForLog(origin);
        logger.warn({ origin: safeOrigin }, "rejecting collaboration connection due to disallowed origin");
        logAuditEvent({
          action: "collaboration.connection",
          outcome: "denied",
          resource: "collaboration.websocket",
          requestId: identifiers.requestId,
          traceId: identifiers.traceId,
          details: { reason: originDenialReason, origin: safeOrigin },
        });
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    if (!incrementConnection(ip, connectionLimitPerIp)) {
      logger.warn({ ip: hashedIp }, "rejecting collaboration connection due to per-IP limit");
      logAuditEvent({
        action: "collaboration.connection",
        outcome: "denied",
        resource: "collaboration.websocket",
        requestId: identifiers.requestId,
        traceId: identifiers.traceId,
        details: { reason: "ip_rate_limited", ip: hashedIp },
      });
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: 60\r\n\r\n");
      socket.destroy();
      return;
    }

    const authResult = authenticateCollaborationRequest(request, sessionCookieName);
    if (authResult.status === "error") {
      logger.warn({ reason: authResult.reason, source: authResult.source }, "rejecting collaboration connection due to invalid session");
      logAuditEvent({
        action: "collaboration.connection",
        outcome: "denied",
        resource: "collaboration.websocket",
        requestId: identifiers.requestId,
        traceId: identifiers.traceId,
        subject: auditSubjectFromSession(authResult.status === "ok" ? authResult.session : undefined),
        details: { reason: authResult.reason, source: authResult.source },
      });
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      decrementConnection(ip);
      return;
    }

    wss.handleUpgrade(request, socket, head, async (ws) => {
      const derived = deriveRoomId(request, authResult.session, authResult.sessionId);
      if (!derived.roomId || !derived.filePath) {
        logger.warn(
          { error: derived.error, source: authResult.source },
          "rejecting collaboration connection due to identity mismatch",
        );
        logAuditEvent({
          action: "collaboration.connection",
          outcome: "denied",
          resource: "collaboration.websocket",
          requestId: identifiers.requestId,
          traceId: identifiers.traceId,
          subject: auditSubjectFromSession(authResult.session),
          details: { reason: derived.error ?? "identity_mismatch", source: authResult.source },
        });
        ws.close(CLOSE_CODE_UNAUTHORIZED, "unauthorized");
        decrementConnection(ip);
        return;
      }

      const maxRooms = resolveRoomLimitFromEnv();
      const existingRoom = rooms.get(derived.roomId);
      if (!existingRoom && rooms.size >= maxRooms) {
        logger.warn({ roomLimit: maxRooms }, "rejecting collaboration connection due to room limit");
        logAuditEvent({
          action: "collaboration.connection",
          outcome: "denied",
          resource: "collaboration.websocket",
          requestId: identifiers.requestId,
          traceId: identifiers.traceId,
          subject: auditSubjectFromSession(authResult.session),
          details: { reason: "room_limit", maxRooms },
        });
        ws.close(1013, "service unavailable");
        decrementConnection(ip);
        return;
      }

      const room = existingRoom ?? getRoomState(derived.roomId, derived.filePath);
      try {
        await loadRoomFromDisk(derived.roomId, room, logger);
      } catch (error) {
        logger.warn({ err: normalizeError(error), roomId: derived.roomId }, "failed to hydrate room from disk");
      }

      room.clients.add(ws);
      logger.info(
        {
          roomId: derived.roomId,
          tenantId: authResult.session.tenantId,
          sessionId: authResult.sessionId,
        },
        "collaboration connection established",
      );
      logAuditEvent({
        action: "collaboration.connection",
        outcome: "success",
        resource: "collaboration.websocket",
        requestId: identifiers.requestId,
        traceId: identifiers.traceId,
        subject: auditSubjectFromSession(authResult.session),
        details: { roomId: derived.roomId },
      });
      ws.once("close", () => {
        room.clients.delete(ws);
        decrementConnection(ip);
        logger.info({ roomId: derived.roomId, sessionId: authResult.sessionId }, "collaboration connection closed");
        logAuditEvent({
          action: "collaboration.connection.closed",
          outcome: "success",
          resource: "collaboration.websocket",
          requestId: identifiers.requestId,
          traceId: identifiers.traceId,
          subject: auditSubjectFromSession(authResult.session),
          details: { roomId: derived.roomId },
        });
      });

      setupWSConnection(ws, request, { docName: derived.roomId, gc: true, getYDoc: () => room.doc });
    });
  });
}

// Exported for tests only.
export function resetIpConnectionCountsForTesting(): void {
  ipConnectionCounts.clear();
}

// Exported for tests only.
export function getIpConnectionCountForTesting(ip: string): number | undefined {
  return ipConnectionCounts.get(ip);
}

// Exported for tests only.
export function getTrackedIpCountForTesting(): number {
  return ipConnectionCounts.size;
}

// Exported for tests only.
export function runRoomMaintenanceForTesting(): Promise<void> {
  return scanRooms();
}

export function isRoomBusy(roomId: string, thresholdMs = 5000): boolean {
  const room = rooms.get(roomId);
  if (!room || room.lastUserEditAt === 0) {
    return false;
  }
  return Date.now() - room.lastUserEditAt < thresholdMs;
}

export function applyAgentEditToRoom(roomId: string, filePath: string, newContent: string): CollabDoc {
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
