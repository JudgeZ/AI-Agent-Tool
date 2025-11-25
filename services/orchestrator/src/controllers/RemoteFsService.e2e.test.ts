import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loadConfig, type AppConfig } from "../config.js";
import type { ExtendedRequest } from "../http/types.js";
import type { RateLimitStore } from "../rateLimit/store.js";
import { RemoteFsController } from "./RemoteFsController.js";

vi.mock("$lib/config", () => ({ orchestratorBaseUrl: "http://127.0.0.1:0" }));

import { __fsTest } from "../../../../apps/gui/src/lib/services/fs.js";

const { RemoteFsService } = __fsTest;

function buildConfig(root: string): AppConfig {
  const base = loadConfig();
  return {
    ...base,
    auth: { ...base.auth, oidc: { ...base.auth.oidc, enabled: false } },
    server: {
      ...base.server,
      remoteFs: { ...base.server.remoteFs, root },
      rateLimits: {
        ...base.server.rateLimits,
        remoteFs: { ...base.server.rateLimits.remoteFs },
      },
    },
  } satisfies AppConfig;
}

function buildApp(config: AppConfig, rateLimiter: RateLimitStore) {
  const controller = new RemoteFsController(config, rateLimiter);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as ExtendedRequest).auth = { session: { id: "session", subject: "user" } as any };
    next();
  });

  app.get("/remote-fs/list", (req, res) => controller.list(req as ExtendedRequest, res));
  app.get("/remote-fs/read", (req, res) => controller.read(req as ExtendedRequest, res));
  app.post("/remote-fs/write", (req, res) => controller.write(req as ExtendedRequest, res));

  return app;
}

async function startServer(app: express.Express) {
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

describe("RemoteFsService end-to-end", () => {
  const rateLimiter: RateLimitStore = {
    allow: vi.fn().mockResolvedValue({ allowed: true }),
  } as unknown as RateLimitStore;

  let tempDir: string;
  let server: { url: string; close: () => Promise<void> } | null = null;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-fs-e2e-"));
    const app = buildApp(buildConfig(tempDir), rateLimiter);
    server = await startServer(app);
  });

  afterAll(async () => {
    await server?.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("lists, reads, and writes via the orchestrator controller", async () => {
    const service = new RemoteFsService({ baseUrl: server!.url });

    await service.writeFile("/workspace/example.txt", "hello world");
    const content = await service.readFile("/workspace/example.txt");
    expect(content).toBe("hello world");

    const listing = await service.readDir("/workspace");
    const entryNames = listing.map((entry) => entry.name);

    expect(entryNames).toContain("example.txt");
    await expect(fs.readFile(path.join(tempDir, "example.txt"), "utf8")).resolves.toBe("hello world");
  });
});
