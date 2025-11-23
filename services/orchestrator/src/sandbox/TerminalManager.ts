import { spawn, type IPty, type IDisposable } from "node-pty";
import { WebSocket } from "ws";
import { z } from "zod";

import { appLogger, type AppLogger, normalizeError } from "../observability/logger.js";

const MAX_MESSAGE_LENGTH = 16_384;

const terminalMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max(8192) }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(1).max(500),
    rows: z.number().int().min(1).max(200),
  }),
]);

export type TerminalMessage = z.infer<typeof terminalMessageSchema>;

export type TerminalBroadcast =
  | { type: "status"; status: "connected" | "disconnected"; clients: number }
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number; signal?: number };

type TerminalSession = {
  pty: IPty;
  clients: Set<WebSocket>;
  disposables: IDisposable[];
};

export type TerminalManagerOptions = {
  shell?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
  logger?: AppLogger;
};

export class TerminalManager {
  private readonly shell: string;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnImpl: typeof spawn;
  private readonly logger: AppLogger;
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly creatingSessions = new Set<string>();

  constructor(options: TerminalManagerOptions = {}) {
    this.shell = options.shell?.trim() || process.env.SHELL || "/bin/bash";
    this.cwd = options.cwd ?? process.cwd();
    this.env = { ...process.env, ...options.env };
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.logger = (options.logger ?? appLogger).child({ component: "terminal" });
  }

  attach(sessionId: string, socket: WebSocket): "attached" | "pending" | "failed" {
    if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
      this.logger.warn({ sessionId }, "rejecting closed terminal websocket");
      try {
        socket.close(1011, "terminal socket closed");
      } catch (error) {
        this.logger.warn({ sessionId, err: normalizeError(error) }, "failed to close stale terminal socket");
      }
      return "failed";
    }

    if (this.creatingSessions.has(sessionId)) {
      queueMicrotask(() => this.attach(sessionId, socket));
      return "pending";
    }

    this.creatingSessions.add(sessionId);
    const session = this.sessions.get(sessionId) ?? this.safeCreateSession(sessionId, socket);
    this.creatingSessions.delete(sessionId);
    if (!session) {
      return "failed";
    }
    session.clients.add(socket);
    this.safeBroadcast(sessionId, { type: "status", status: "connected", clients: session.clients.size });

    socket.on("message", (raw) => this.handleClientMessage(sessionId, socket, raw));
    socket.on("close", () => this.detach(sessionId, socket));
    socket.on("error", (error) => {
      this.logger.warn({ sessionId, err: normalizeError(error) }, "terminal websocket error");
    });
    return "attached";
  }

  detach(sessionId: string, socket: WebSocket): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.clients.delete(socket);
    this.safeBroadcast(sessionId, { type: "status", status: "disconnected", clients: session.clients.size });
    if (session.clients.size === 0) {
      this.destroySession(sessionId);
    }
  }

  shutdown(): void {
    for (const sessionId of Array.from(this.sessions.keys())) {
      this.destroySession(sessionId, true);
    }
  }

  private safeCreateSession(sessionId: string, socket: WebSocket): TerminalSession | null {
    try {
      return this.createSession(sessionId);
    } catch (error) {
      this.logger.error({ sessionId, err: normalizeError(error) }, "failed to start terminal session");
      try {
        socket.close(1011, "terminal unavailable");
      } catch (closeError) {
        this.logger.warn({ sessionId, err: normalizeError(closeError) }, "failed to close terminal client after spawn failure");
      }
      return null;
    }
  }

  private createSession(sessionId: string): TerminalSession {
    this.logger.info({ sessionId, cwd: this.cwd, shell: this.shell }, "starting terminal session");
    const pty = this.spawnImpl(this.shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: this.cwd,
      env: this.env,
    });

    const session: TerminalSession = { pty, clients: new Set(), disposables: [] };

    session.disposables.push(
      pty.onData((data) => {
        this.safeBroadcast(sessionId, { type: "output", data });
      }),
    );

    session.disposables.push(
      pty.onExit((event) => {
        this.safeBroadcast(sessionId, { type: "exit", exitCode: event.exitCode, signal: event.signal });
        this.destroySession(sessionId, true);
      }),
    );

    this.sessions.set(sessionId, session);
    return session;
  }

  private destroySession(sessionId: string, closeClients = false): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    this.logger.info({ sessionId }, "closing terminal session");
    this.sessions.delete(sessionId);
    const clients = Array.from(session.clients);
    for (const disposable of session.disposables) {
      try {
        disposable.dispose();
      } catch (error) {
        this.logger.warn({ sessionId, err: normalizeError(error) }, "failed to dispose terminal listener");
      }
    }
    try {
      session.pty.kill();
    } catch (error) {
      this.logger.warn({ sessionId, err: normalizeError(error) }, "failed to kill terminal pty");
    }

    if (closeClients) {
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
          try {
            client.close(1011, "terminal session ended");
          } catch (error) {
            this.logger.warn({ sessionId, err: normalizeError(error) }, "failed to close terminal client");
          }
        }
      }
    }
  }

  private handleClientMessage(sessionId: string, socket: WebSocket, raw: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    const parsed = this.parseClientMessage(raw);
    if (!parsed.ok) {
      const isTooLarge = parsed.reason === "too_large";
      this.logger.warn({ sessionId, reason: parsed.reason }, "closing terminal client due to invalid message");
      try {
        socket.close(isTooLarge ? 1009 : 1008, isTooLarge ? "terminal message too large" : "invalid terminal message");
      } catch (error) {
        this.logger.warn({ sessionId, err: normalizeError(error) }, "failed to close terminal client after invalid message");
      }
      return;
    }

    const message = parsed.value;

    if (message.type === "input") {
      try {
        session.pty.write(message.data);
      } catch (error) {
        this.logger.warn({ sessionId, err: normalizeError(error) }, "failed to write to terminal");
      }
      return;
    }

    if (message.type === "resize") {
      try {
        session.pty.resize(message.cols, message.rows);
      } catch (error) {
        this.logger.warn({ sessionId, err: normalizeError(error) }, "failed to resize terminal");
      }
    }
  }

  private parseClientMessage(
    raw: unknown,
  ): { ok: true; value: TerminalMessage } | { ok: false; reason: "unsupported" | "too_large" | "invalid" } {
    let message: string | null = null;
    if (typeof raw === "string") {
      message = raw;
    } else if (Buffer.isBuffer(raw)) {
      message = raw.toString("utf8");
    } else if (Array.isArray(raw) && raw.every((entry) => Buffer.isBuffer(entry))) {
      message = Buffer.concat(raw).toString("utf8");
    } else if (ArrayBuffer.isView(raw)) {
      message = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
    } else if (raw instanceof ArrayBuffer) {
      message = Buffer.from(raw).toString("utf8");
    }
    if (!message) {
      return { ok: false, reason: "unsupported" };
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return { ok: false, reason: "too_large" };
    }
    try {
      const parsed = JSON.parse(message) as unknown;
      const result = terminalMessageSchema.safeParse(parsed);
      if (result.success) {
        return { ok: true, value: result.data };
      }
      this.logger.debug({ errors: result.error.issues }, "invalid terminal message");
      return { ok: false, reason: "invalid" };
    } catch (error) {
      this.logger.debug({ err: normalizeError(error) }, "failed to parse terminal message");
      return { ok: false, reason: "invalid" };
    }
  }

  private safeSend(socket: WebSocket, payload: TerminalBroadcast | string, sessionId?: string): boolean {
    if (socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
    try {
      socket.send(serialized);
      return true;
    } catch (error) {
      this.logger.warn({ sessionId, err: normalizeError(error) }, "failed to send terminal payload");
      return false;
    }
  }

  private safeBroadcast(sessionId: string, payload: TerminalBroadcast): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const recipients: WebSocket[] = [];
    let prunedBeforeSend = false;

    for (const client of Array.from(session.clients)) {
      if (client.readyState === WebSocket.CLOSED || client.readyState === WebSocket.CLOSING) {
        prunedBeforeSend = true;
        session.clients.delete(client);
        continue;
      }
      recipients.push(client);
    }

    const normalizedPayload: TerminalBroadcast =
      payload.type === "status"
        ? { ...payload, clients: session.clients.size }
        : payload;
    const serializedPayload = JSON.stringify(normalizedPayload);

    let removedDuringSend = false;
    for (const client of recipients) {
      const delivered = this.safeSend(client, serializedPayload, sessionId);
      if (!delivered) {
        removedDuringSend = true;
        session.clients.delete(client);
        try {
          client.close(1011, "terminal delivery failure");
        } catch (error) {
          this.logger.warn({ sessionId, err: normalizeError(error) }, "failed to close terminal client");
        }
      }
    }

    if (payload.type === "status" && removedDuringSend && session.clients.size > 0) {
      const correction: TerminalBroadcast = {
        type: "status",
        status: payload.status,
        clients: session.clients.size,
      };
      const serializedCorrection = JSON.stringify(correction);

      for (const client of Array.from(session.clients)) {
        if (client.readyState === WebSocket.CLOSED || client.readyState === WebSocket.CLOSING) {
          session.clients.delete(client);
          continue;
        }
        const delivered = this.safeSend(client, serializedCorrection, sessionId);
        if (!delivered) {
          session.clients.delete(client);
          try {
            client.close(1011, "terminal delivery failure");
          } catch (error) {
            this.logger.warn({ sessionId, err: normalizeError(error) }, "failed to close terminal client");
          }
        }
      }
    } else if (payload.type !== "status" && (removedDuringSend || prunedBeforeSend) && session.clients.size > 0) {
      const statusPayload: TerminalBroadcast = {
        type: "status",
        status: "disconnected",
        clients: session.clients.size,
      };
      const serializedStatus = JSON.stringify(statusPayload);

      for (const client of Array.from(session.clients)) {
        if (client.readyState === WebSocket.CLOSED || client.readyState === WebSocket.CLOSING) {
          session.clients.delete(client);
          continue;
        }
        const delivered = this.safeSend(client, serializedStatus, sessionId);
        if (!delivered) {
          session.clients.delete(client);
          try {
            client.close(1011, "terminal delivery failure");
          } catch (error) {
            this.logger.warn({ sessionId, err: normalizeError(error) }, "failed to close terminal client");
          }
        }
      }
    }

    if (session.clients.size === 0) {
      this.destroySession(sessionId);
    }
  }
}
