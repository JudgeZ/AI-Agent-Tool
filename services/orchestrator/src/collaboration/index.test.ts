import http from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  applyAgentEditToRoom,
  getRoomStateForTesting,
  isRoomBusy,
  setupCollaborationServer,
} from "./index.js";

describe("collaboration server", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
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
    const doc = applyAgentEditToRoom(roomId, "initial");

    expect(isRoomBusy(roomId)).toBe(false);

    const text = doc.getText("content");
    doc.transact(() => {
      text.insert(text.length, " human");
    }, "human_edit");

    expect(isRoomBusy(roomId, 10000)).toBe(true);
    const state = getRoomStateForTesting(roomId);
    expect(state?.doc).toBe(doc);
  });
});
