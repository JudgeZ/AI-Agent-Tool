import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, type AppConfig } from "../config.js";
import { RemoteFsController } from "./RemoteFsController.js";
import type { ExtendedRequest } from "../http/types.js";
import type { RateLimitStore } from "../rateLimit/store.js";
import type { SessionRecord } from "../auth/SessionStore.js";

function buildConfig(root: string, overrides?: Partial<AppConfig>): AppConfig {
  const base = loadConfig();
  return {
    ...base,
    ...overrides,
    auth: {
      ...base.auth,
      ...overrides?.auth,
      oauth: { ...base.auth.oauth, ...overrides?.auth?.oauth },
      oidc: { ...base.auth.oidc, ...overrides?.auth?.oidc },
    },
    server: {
      ...base.server,
      ...overrides?.server,
      remoteFs: {
        ...base.server.remoteFs,
        ...overrides?.server?.remoteFs,
        root,
      },
      rateLimits: {
        backend: { ...base.server.rateLimits.backend },
        plan: { ...base.server.rateLimits.plan },
        chat: { ...base.server.rateLimits.chat },
        auth: { ...base.server.rateLimits.auth },
        secrets: { ...base.server.rateLimits.secrets },
        remoteFs: { ...base.server.rateLimits.remoteFs },
        ...overrides?.server?.rateLimits,
      },
    },
  } satisfies AppConfig;
}

function buildApp(config: AppConfig, rateLimiter: RateLimitStore, session?: SessionRecord) {
  const controller = new RemoteFsController(config, rateLimiter);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as ExtendedRequest).auth = session ? { session } : undefined;
    next();
  });

  app.get("/remote-fs/list", (req, res) => controller.list(req as ExtendedRequest, res));
  app.get("/remote-fs/read", (req, res) => controller.read(req as ExtendedRequest, res));
  app.post("/remote-fs/write", (req, res) => controller.write(req as ExtendedRequest, res));

  return app;
}

describe("RemoteFsController", () => {
  let tempDir: string;
  const rateLimiter: RateLimitStore = {
    allow: vi.fn().mockResolvedValue({ allowed: true }),
  } as unknown as RateLimitStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-fs-test-"));
    vi.resetAllMocks();
    rateLimiter.allow = vi.fn().mockResolvedValue({ allowed: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("rejects paths that escape the configured root", async () => {
    const config = buildConfig(tempDir, { auth: { oidc: { enabled: false } } });
    const app = buildApp(config, rateLimiter);

    const res = await request(app)
      .get("/remote-fs/list")
      .query({ path: path.join(tempDir, "../outside") });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_request");
  });

  it("lists directory entries within the root", async () => {
    await fs.mkdir(path.join(tempDir, "nested"));
    await fs.writeFile(path.join(tempDir, "file.txt"), "hello");

    const config = buildConfig(tempDir, { auth: { oidc: { enabled: false } } });
    const app = buildApp(config, rateLimiter);

    const res = await request(app)
      .get("/remote-fs/list")
      .query({ path: tempDir });

    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "file.txt", path: expect.stringContaining("file.txt") }),
        expect.objectContaining({ name: "nested", isDirectory: true }),
      ]),
    );
  });

  it("rejects listing a symlink that points outside the root", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-fs-outside-"));
    await fs.symlink(outsideDir, path.join(tempDir, "link"));

    const config = buildConfig(tempDir, { auth: { oidc: { enabled: false } } });
    const app = buildApp(config, rateLimiter);

    const res = await request(app)
      .get("/remote-fs/list")
      .query({ path: path.join(tempDir, "link") });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_request");

    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it("blocks writes that traverse symlinks outside the root", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-fs-outside-"));
    await fs.symlink(outsideDir, path.join(tempDir, "link"));

    const config = buildConfig(tempDir, { auth: { oidc: { enabled: false } } });
    const app = buildApp(config, rateLimiter);

    const res = await request(app)
      .post("/remote-fs/write")
      .send({ path: `${tempDir}/link/escape.txt`, content: "data" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_request");

    const escapedExists = await fs
      .stat(path.join(outsideDir, "escape.txt"))
      .then(() => true)
      .catch(() => false);
    expect(escapedExists).toBe(false);

    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it("creates nested missing directories without dropping intermediate segments", async () => {
    const config = buildConfig(tempDir, { auth: { oidc: { enabled: false } } });
    const app = buildApp(config, rateLimiter);

    const res = await request(app)
      .post("/remote-fs/write")
      .send({ path: `${tempDir}/new/subdir/file.txt`, content: "data" });

    expect(res.status).toBe(204);
    const content = await fs.readFile(path.join(tempDir, "new", "subdir", "file.txt"), "utf8");
    expect(content).toBe("data");
  });

  it("maps the default virtual root segment to the configured workspace root", async () => {
    const targetFile = path.join(tempDir, "virtual.txt");
    await fs.writeFile(targetFile, "virtual-root");

    const config = buildConfig(tempDir, { auth: { oidc: { enabled: false } } });
    const app = buildApp(config, rateLimiter);

    const res = await request(app)
      .get("/remote-fs/read")
      .query({ path: "/workspace/virtual.txt" });

    expect(res.status).toBe(200);
    expect(res.body.content).toBe("virtual-root");
  });

  it("rejects reads that resolve through symlinks outside the root", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-fs-outside-"));
    const outsideFile = path.join(outsideDir, "secret.txt");
    await fs.writeFile(outsideFile, "secret");
    await fs.symlink(outsideFile, path.join(tempDir, "link.txt"));

    const config = buildConfig(tempDir, { auth: { oidc: { enabled: false } } });
    const app = buildApp(config, rateLimiter);

    const res = await request(app)
      .get("/remote-fs/read")
      .query({ path: path.join(tempDir, "link.txt") });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_request");

    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it("enforces the configured max write size", async () => {
    const config = buildConfig(tempDir, {
      auth: { oidc: { enabled: false } },
      server: { remoteFs: { maxWriteBytes: 4 } },
    });
    const app = buildApp(config, rateLimiter);

    const res = await request(app)
      .post("/remote-fs/write")
      .send({ path: `${tempDir}/tiny.txt`, content: "too-long" });

    expect(res.status).toBe(413);
    expect(res.body.code).toBe("payload_too_large");
  });

  it("requires authentication when OIDC is enabled", async () => {
    const config = buildConfig(tempDir, { auth: { oidc: { enabled: true } } });
    const app = buildApp(config, rateLimiter);

    const res = await request(app)
      .get("/remote-fs/list")
      .query({ path: tempDir });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("unauthorized");
  });

  it("respects rate limit denials", async () => {
    const config = buildConfig(tempDir, { auth: { oidc: { enabled: false } } });
    const app = buildApp(config, rateLimiter);
    vi.mocked(rateLimiter.allow).mockResolvedValueOnce({ allowed: false, retryAfterMs: 50 } as any);

    const res = await request(app)
      .get("/remote-fs/read")
      .query({ path: path.join(tempDir, "missing.txt") });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe("too_many_requests");
  });
});
