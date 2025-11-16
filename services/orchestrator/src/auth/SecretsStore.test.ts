import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test, vi } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "undici";
import { GenericContainer, type StartedTestContainer } from "testcontainers";

import { LocalFileStore, VaultStore } from "./SecretsStore.js";
import { appLogger } from "../observability/logger.js";

describe("LocalFileStore", () => {
  test("persists encrypted secrets to disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "secrets-store-"));
    const file = path.join(dir, "secrets.json");
    const passphrase = "test-passphrase";

    const store = new LocalFileStore({ filePath: file, passphrase });
    await store.set("alpha", "bravo");
    await store.set("token", "value");

    expect(await store.get("alpha")).toBe("bravo");

    const raw = await readFile(file, "utf-8");
    expect(raw).not.toContain("bravo");
    expect(raw).not.toContain("value");

    const reloaded = new LocalFileStore({ filePath: file, passphrase });
    expect(await reloaded.get("alpha")).toBe("bravo");
    expect(await reloaded.get("token")).toBe("value");

    await reloaded.delete("alpha");
    expect(await reloaded.get("alpha")).toBeUndefined();
  }, 15000);

  test("reads legacy payloads without KDF metadata", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "legacy-keystore-"));
    const file = path.join(dir, "secrets.json");
    const passphrase = "test-passphrase";

    const store = new LocalFileStore({ filePath: file, passphrase });
    await store.set("legacy", "value");

    const raw = await readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as { salt: string; nonce: string; cipher: string } & Record<string, unknown>;
    const legacyPayload = {
      salt: parsed.salt,
      nonce: parsed.nonce,
      cipher: parsed.cipher
    };
    await writeFile(file, JSON.stringify(legacyPayload, null, 2));

    const reloaded = new LocalFileStore({ filePath: file, passphrase });
    expect(await reloaded.get("legacy")).toBe("value");
  }, 15000);

  test("uses config/secrets/local under the current working directory", async () => {
    const tempCwd = await mkdtemp(path.join(tmpdir(), "keystore-default-"));
    const originalCwd = process.cwd();
    const originalPassphrase = process.env.LOCAL_SECRETS_PASSPHRASE;
    const originalPath = process.env.LOCAL_SECRETS_PATH;

    process.chdir(tempCwd);
    delete process.env.LOCAL_SECRETS_PATH;
    process.env.LOCAL_SECRETS_PASSPHRASE = "dev-local-passphrase";

    try {
      const store = new LocalFileStore();
      await store.set("example", "value");

      const expectedDir = path.join(tempCwd, "config", "secrets", "local");
      const expectedFile = path.join(expectedDir, "secrets.json");

      const directoryStats = await stat(expectedDir);
      expect(directoryStats.isDirectory()).toBe(true);

      const raw = await readFile(expectedFile, "utf-8");
      expect(raw.length).toBeGreaterThan(0);
    } finally {
      process.chdir(originalCwd);

      if (originalPath === undefined) {
        delete process.env.LOCAL_SECRETS_PATH;
      } else {
        process.env.LOCAL_SECRETS_PATH = originalPath;
      }

      if (originalPassphrase === undefined) {
        delete process.env.LOCAL_SECRETS_PASSPHRASE;
      } else {
        process.env.LOCAL_SECRETS_PASSPHRASE = originalPassphrase;
      }
    }
  });
});

describe("VaultStore", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  function resetEnvironment() {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    resetEnvironment();
  });

  afterEach(() => {
    resetEnvironment();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
    vi.unstubAllGlobals();
  });

  test("wires TLS overrides through undici dispatcher", async () => {
    process.env.VAULT_ADDR = "https://vault.example.com";
    process.env.VAULT_TOKEN = "token";
    process.env.VAULT_KV_MOUNT = "kv";
    process.env.VAULT_CA_CERT = "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----";

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ data: { data: { value: "secret-value" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const store = new VaultStore();
    const value = await store.get("provider:openai:apiKey");

    expect(value).toBe("secret-value");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://vault.example.com/v1/kv/data/provider/openai/apiKey");
    expect(init?.dispatcher).toBeInstanceOf(Agent);
  });

  test("applies tenant namespace templates when keys use tenant prefixes", async () => {
    process.env.VAULT_ADDR = "https://vault.example.com";
    process.env.VAULT_TOKEN = "token";
    process.env.VAULT_NAMESPACE = "root";
    process.env.VAULT_TENANT_NAMESPACE_TEMPLATE = "tenants/{tenant}";

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: { data: { value: "secret-value" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const store = new VaultStore();
    await store.get("tenant:acme:provider:openai:apiKey");

    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    expect(headers.get("X-Vault-Namespace")).toBe("root/tenants/acme");
  });

  test("skips tenant namespace templating when the identifier is unsafe", async () => {
    process.env.VAULT_ADDR = "https://vault.example.com";
    process.env.VAULT_TOKEN = "token";
    process.env.VAULT_NAMESPACE = "root";
    process.env.VAULT_TENANT_NAMESPACE_TEMPLATE = "tenants/{tenant}";

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const store = new VaultStore();
    await store.get("tenant:../provider:openai:apiKey");

    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    expect(headers.get("X-Vault-Namespace")).toBe("root");
  });

  test("skips tenant namespace templating when the identifier contains illegal characters", async () => {
    process.env.VAULT_ADDR = "https://vault.example.com";
    process.env.VAULT_TOKEN = "token";
    process.env.VAULT_NAMESPACE = "root";
    process.env.VAULT_TENANT_NAMESPACE_TEMPLATE = "tenants/{tenant}";

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const store = new VaultStore();
    await store.get("tenant:acme@corp:provider:openai:apiKey");

    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    expect(headers.get("X-Vault-Namespace")).toBe("root");
  });

  test("raises errors when Vault responds with a 5xx status", async () => {
    process.env.VAULT_ADDR = "https://vault.example.com";
    process.env.VAULT_TOKEN = "token";

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const store = new VaultStore();
    await expect(() => store.get("provider:openai:apiKey")).rejects.toThrow(
      "Vault request failed with status 500",
    );
  });

  test("includes error details from Vault responses when available", async () => {
    process.env.VAULT_ADDR = "https://vault.example.com";
    process.env.VAULT_TOKEN = "token";

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ errors: ["permission denied"] }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const store = new VaultStore();
    await expect(() =>
      store.set("provider:openai:apiKey", "secret"),
    ).rejects.toThrow("Vault request failed with status 403: permission denied");
  });

  test("truncates oversized Vault error bodies", async () => {
    process.env.VAULT_ADDR = "https://vault.example.com";
    process.env.VAULT_TOKEN = "token";

    const longError = "x".repeat(600);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(longError, { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    const store = new VaultStore();
    await expect(() => store.delete("provider:openai:apiKey")).rejects.toThrow(
      /Vault request failed with status 502: x{256}…/,
    );
  });

  test("returns undefined when vault returns 404", async () => {
    process.env.VAULT_ADDR = "https://vault.example.com";
    process.env.VAULT_TOKEN = "token";

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const store = new VaultStore();
    const value = await store.get("missing:secret");

    expect(value).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://vault.example.com/v1/secret/data/missing/secret",
      expect.objectContaining({ dispatcher: undefined })
    );
  });

  test("throws when token and auth configuration are not provided", () => {
    process.env.VAULT_ADDR = "https://vault.example.com";
    delete process.env.VAULT_TOKEN;
    delete process.env.VAULT_AUTH_METHOD;

    expect(() => new VaultStore()).toThrow("VaultStore requires VAULT_TOKEN or supported auth configuration");
  });

  test("authenticates with kubernetes when no token is provided", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vault-k8s-auth-"));
    const jwtPath = path.join(dir, "token");
    await writeFile(jwtPath, "jwt-token");

    process.env.VAULT_ADDR = "https://vault.example.com";
    delete process.env.VAULT_TOKEN;
    process.env.VAULT_KV_MOUNT = "secrets";
    process.env.VAULT_AUTH_METHOD = "kubernetes";
    process.env.VAULT_ROLE = "orchestrator";
    process.env.VAULT_K8S_TOKEN_PATH = jwtPath;

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ auth: { client_token: "vault-token", lease_duration: 120 } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { data: { value: "secret-value" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const store = new VaultStore();
    const value = await store.get("provider:anthropic:apiKey");

    expect(value).toBe("secret-value");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const loginCall = fetchMock.mock.calls[0];
    expect(loginCall[0]).toBe("https://vault.example.com/v1/auth/kubernetes/login");
    const loginInit = loginCall[1] as RequestInit;
    const loginHeaders = new Headers(loginInit?.headers);
    expect(loginHeaders.get("X-Vault-Token")).toBeNull();
    expect(JSON.parse((loginInit?.body as string) ?? "")).toEqual({ role: "orchestrator", jwt: "jwt-token" });

    const secretCall = fetchMock.mock.calls[1];
    const secretHeaders = new Headers((secretCall[1] as RequestInit | undefined)?.headers);
    expect(secretHeaders.get("X-Vault-Token")).toBe("vault-token");
  });

  test("retries kubernetes authentication when token is rejected", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vault-k8s-refresh-"));
    const jwtPath = path.join(dir, "token");
    await writeFile(jwtPath, "jwt-token");

    process.env.VAULT_ADDR = "https://vault.example.com";
    delete process.env.VAULT_TOKEN;
    process.env.VAULT_KV_MOUNT = "secret";
    process.env.VAULT_AUTH_METHOD = "kubernetes";
    process.env.VAULT_ROLE = "orchestrator";
    process.env.VAULT_K8S_TOKEN_PATH = jwtPath;

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ auth: { client_token: "vault-token", lease_duration: 60 } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ auth: { client_token: "vault-token-2", lease_duration: 60 } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { data: { value: "refreshed" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const store = new VaultStore();
    const value = await store.get("provider:openai:apiKey");

    expect(value).toBe("refreshed");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const retryLoginInit = fetchMock.mock.calls[2][1] as RequestInit;
    expect(JSON.parse((retryLoginInit?.body as string) ?? "")).toEqual({ role: "orchestrator", jwt: "jwt-token" });

    const finalHeaders = new Headers((fetchMock.mock.calls[3][1] as RequestInit | undefined)?.headers);
    expect(finalHeaders.get("X-Vault-Token")).toBe("vault-token-2");
  });
});

describe("VaultStore (integration)", () => {
  const rootToken = "test-root";
  let container: StartedTestContainer | null = null;
  let baseUrl: string | null = null;
  let skipSuite = false;

  beforeAll(async () => {
    try {
      container = await new GenericContainer("hashicorp/vault:1.15")
        .withCommand(["server", "-dev", "-dev-root-token-id=" + rootToken, "-dev-listen-address=0.0.0.0:8200"])
        .withExposedPorts(8200)
        .start();
      const host = container.getHost();
      const port = container.getMappedPort(8200);
      baseUrl = `http://${host}:${port}`;
      // Wait for Vault to be ready
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          const health = await fetch(`${baseUrl}/v1/sys/health`);
          if (health.status === 200 || health.status === 472 || health.status === 473) {
            break;
          }
        } catch {
          // ignore
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      skipSuite = true;
      appLogger.warn(
        { event: "test.skip", reason: "missing_container_runtime", test: "SecretsStore.vault" },
        "Skipping Vault integration test because no container runtime is available",
      );
      appLogger.warn(
        { event: "test.skip.detail", test: "SecretsStore.vault" },
        String(error),
      );
    }
  }, 90000);

  afterAll(async () => {
    if (container) {
      await container.stop().catch(() => undefined);
      container = null;
    }
  });

  it(
    "reads and writes secrets through a Vault dev server",
    async () => {
      if (skipSuite || !baseUrl) {
        expect(true).toBe(true);
        return;
      }

      const secretPath = "app/service";
      const initialValue = "s3cr3t";
      const updatedValue = "rotated";

      const writeResp = await fetch(`${baseUrl}/v1/secret/data/${secretPath}`, {
        method: "POST",
        headers: {
          "X-Vault-Token": rootToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ data: { value: initialValue } })
      });
      expect(writeResp.ok).toBe(true);

      const store = new VaultStore({
        url: baseUrl,
        token: rootToken
      });

      await expect(store.get(secretPath)).resolves.toBe(initialValue);

      await store.set(secretPath, updatedValue);

      const verify = await fetch(`${baseUrl}/v1/secret/data/${secretPath}`, {
        headers: {
          "X-Vault-Token": rootToken
        }
      });
      expect(verify.ok).toBe(true);
      const payload = (await verify.json()) as { data?: { data?: { value?: string } } };
      expect(payload.data?.data?.value).toBe(updatedValue);

      await store.delete(secretPath);
      await expect(store.get(secretPath)).resolves.toBeUndefined();
    },
    90000
  );
});
