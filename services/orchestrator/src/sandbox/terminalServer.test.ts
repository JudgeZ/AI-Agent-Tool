import http from "node:http";

import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node-pty", () => ({ spawn: vi.fn() }));
import { WebSocketServer } from "ws";

import type { AppConfig } from "../config.js";
import { setupTerminalServer } from "./terminalServer.js";

describe("terminalServer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
});

