import http from "node:http";

import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node-pty", () => ({ spawn: vi.fn() }));
import WebSocket, { WebSocketServer } from "ws";

import type { AppConfig } from "../config.js";
import { TerminalManager } from "./TerminalManager.js";
import * as wsUtils from "../http/wsUtils.js";
import * as audit from "../observability/audit.js";
import { setupTerminalServer } from "./terminalServer.js";

describe("terminalServer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.TERMINAL_MAX_UNIQUE_IPS;
  });

  it("closes the websocket server when the http server shuts down", () => {
    const server = new http.Server();
    const config = {
      auth: { oidc: { session: { cookieName: "sid" } } },
      server: { cors: { allowedOrigins: [] }, trustedProxyCidrs: [] },
    } as unknown as AppConfig;

    const closeSpy = vi
      .spyOn(WebSocketServer.prototype, "close")
      .mockImplementation(function (this: WebSocketServer, cb?: () => void) {
        cb?.();
      });

    setupTerminalServer(server, config);

    server.emit("close");

    expect(closeSpy).toHaveBeenCalled();
  });

  it("rejects upgrades when the unique IP capacity is exceeded", () => {
    process.env.TERMINAL_MAX_UNIQUE_IPS = "1";

    const server = new http.Server();
    const config = {
      auth: { oidc: { session: { cookieName: "sid" } } },
      server: { cors: { allowedOrigins: [] }, trustedProxyCidrs: [] },
    } as unknown as AppConfig;

    const handleUpgradeSpy = vi
      .spyOn(WebSocketServer.prototype, "handleUpgrade")
      .mockImplementation((_req, _socket, _head, cb) => {
        const mockWs = {
          on: vi.fn(),
          off: vi.fn(),
          close: vi.fn(),
          readyState: WebSocket.OPEN,
        } as unknown as WebSocket;
        cb(mockWs);
      });

    vi.spyOn(audit, "logAuditEvent").mockImplementation(() => {});
    vi.spyOn(wsUtils, "authenticateSessionFromUpgrade").mockReturnValue({
      status: "ok",
      session: {
        id: "11111111-1111-1111-1111-111111111111",
        subject: "user-1",
        email: "user@example.com",
      },
      sessionId: "11111111-1111-1111-1111-111111111111",
      source: "cookie",
    });
    vi.spyOn(wsUtils, "requestIdentifiers").mockReturnValue({ requestId: "req-1", traceId: "trace-1" });
    vi.spyOn(wsUtils, "loggerWithTrace").mockReturnValue({
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as ReturnType<typeof wsUtils.loggerWithTrace>);
    vi.spyOn(wsUtils, "resolveClientIp").mockImplementation((req) => req.socket.remoteAddress ?? "unknown");
    vi.spyOn(wsUtils, "incrementConnectionCount").mockImplementation((ip, _limit, counts) => {
      const current = counts.get(ip) ?? 0;
      counts.set(ip, current + 1);
      return true;
    });
    vi.spyOn(wsUtils, "decrementConnectionCount").mockImplementation((ip, counts) => {
      counts.delete(ip);
    });

    vi.spyOn(TerminalManager.prototype, "attach").mockReturnValue("attached");

    setupTerminalServer(server, config);

    const firstSocket = {
      write: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as Parameters<typeof server.emit>[1];
    const secondSocket = {
      write: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as Parameters<typeof server.emit>[1];

    const requestBase = { headers: {}, httpVersion: "1.1" } as http.IncomingMessage;

    const firstRequest = Object.assign(Object.create(requestBase), {
      url: "/sandbox/terminal?sessionId=11111111-1111-1111-1111-111111111111",
      socket: { remoteAddress: "10.0.0.1" },
    });

    const secondRequest = Object.assign(Object.create(requestBase), {
      url: "/sandbox/terminal?sessionId=11111111-1111-1111-1111-111111111111",
      socket: { remoteAddress: "10.0.0.2" },
    });

    server.emit("upgrade", firstRequest, firstSocket, Buffer.alloc(0));
    expect(handleUpgradeSpy).toHaveBeenCalledTimes(1);
    handleUpgradeSpy.mockClear();

    server.emit("upgrade", secondRequest, secondSocket, Buffer.alloc(0));

    expect(handleUpgradeSpy).not.toHaveBeenCalled();
    expect(secondSocket.write).toHaveBeenCalledWith(
      expect.stringContaining("503 Service Unavailable"),
    );
    expect(secondSocket.destroy).toHaveBeenCalled();
  });
});

