import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionStore } from "../auth/SessionStore.js";
import { createOidcEnabledConfig } from "../test/utils.js";

vi.mock("../providers/ProviderRegistry.js", async () => {
  const { VersionedSecretsManager } = await import("../auth/VersionedSecretsManager.js");
  const storage = new Map<string, string>();
  const secretsStore = {
    async get(key: string): Promise<string | undefined> {
      return storage.get(key);
    },
    async set(key: string, value: string): Promise<void> {
      storage.set(key, value);
    },
    async delete(key: string): Promise<void> {
      storage.delete(key);
    },
    __reset(): void {
      storage.clear();
    },
  };
  const manager = new VersionedSecretsManager(secretsStore);
  return {
    routeChat: vi.fn().mockResolvedValue({
      output: "hello",
      usage: { promptTokens: 5, completionTokens: 3 },
    }),
    getSecretsStore: () => secretsStore,
    getVersionedSecretsManager: () => manager,
  };
});

const policyMock = {
  enforceHttpAction: vi.fn().mockResolvedValue({ allow: true, deny: [] })
};

vi.mock("../policy/PolicyEnforcer.js", () => {
  class MockPolicyViolationError extends Error {
    status: number;
    details: unknown;

    constructor(message: string, details: unknown = [], status = 403) {
      super(message);
      this.status = status;
      this.details = details;
    }
  }

  return {
    getPolicyEnforcer: () => policyMock,
    PolicyViolationError: MockPolicyViolationError
  };
});

// Mock PlanQueueRuntime not strictly needed for secrets but app initialization might require it if it imports it?
// api.test.ts mocked it. index.js might import it.
// createServer imports ./queue/PlanQueueRuntime.js?
// index.ts imports: import { initializePlanQueueRuntime } from "./queue/PlanQueueRuntime.js";
// So yes, we need to mock it to avoid real initialization.
vi.mock("../queue/PlanQueueRuntime.js", () => {
  return {
    initializePlanQueueRuntime: vi.fn().mockResolvedValue(undefined),
    submitPlanSteps: vi.fn().mockResolvedValue(undefined),
    resolvePlanStepApproval: vi.fn().mockResolvedValue(undefined),
    getPlanSubject: vi.fn().mockResolvedValue(undefined),
    getPersistedPlanStep: vi.fn().mockResolvedValue(undefined)
  };
});

const TEST_SECRET_KEY = "oauth:openrouter:refresh_token";

async function resetSecretFixtures(): Promise<void> {
  const { getVersionedSecretsManager, getSecretsStore } = await import("../providers/ProviderRegistry.js");
  const manager = getVersionedSecretsManager();
  try {
    await manager.clear(TEST_SECRET_KEY);
  } catch {
    // ignore missing secret state
  }
  const store = getSecretsStore() as { __reset?: () => void };
  if (typeof store.__reset === "function") {
    store.__reset();
  }
}

describe("secret management routes", () => {
  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    await resetSecretFixtures();
  });

  afterEach(() => {
    vi.clearAllMocks();
    policyMock.enforceHttpAction.mockReset();
    policyMock.enforceHttpAction.mockResolvedValue({ allow: true, deny: [] });
    sessionStore.clear();
  });

  it("rotates secrets and lists versions", async () => {
    const { createServer } = await import("../index.js");
    const app = createServer();

    const rotateResponse = await request(app)
      .post(`/secrets/${TEST_SECRET_KEY}/rotate`)
      .send({
        value: "refresh-token-001",
        retain: 3,
        labels: { provider: "openrouter", environment: "test" },
      })
      .expect(200);

    expect(rotateResponse.body.version).toMatchObject({
      id: expect.any(String),
      isCurrent: true,
      labels: expect.objectContaining({ provider: "openrouter" }),
    });

    const versionsResponse = await request(app)
      .get(`/secrets/${TEST_SECRET_KEY}/versions`)
      .expect(200);

    expect(Array.isArray(versionsResponse.body.versions)).toBe(true);
    expect(versionsResponse.body.versions[0]).toMatchObject({
      id: rotateResponse.body.version.id,
      isCurrent: true,
    });
  });

  it("promotes a previous secret version", async () => {
    const { createServer } = await import("../index.js");
    const app = createServer();
    const { getVersionedSecretsManager } = await import("../providers/ProviderRegistry.js");
    const manager = getVersionedSecretsManager();

    const firstRotate = await request(app)
      .post(`/secrets/${TEST_SECRET_KEY}/rotate`)
      .send({ value: "first-secret" })
      .expect(200);

    await request(app)
      .post(`/secrets/${TEST_SECRET_KEY}/rotate`)
      .send({ value: "second-secret" })
      .expect(200);

    const promoteResponse = await request(app)
      .post(`/secrets/${TEST_SECRET_KEY}/promote`)
      .send({ versionId: firstRotate.body.version.id })
      .expect(200);

    expect(promoteResponse.body.version.id).toBe(firstRotate.body.version.id);
    const current = await manager.getCurrentValue(TEST_SECRET_KEY);
    expect(current?.value).toBe("first-secret");
    expect(current?.version).toBe(firstRotate.body.version.id);
  });

  it("rejects secret access when policy denies", async () => {
    const { createServer } = await import("../index.js");
    const app = createServer();

    policyMock.enforceHttpAction.mockResolvedValueOnce({
      allow: false,
      deny: [{ capability: "secrets.manage", reason: "forbidden" }],
    });

    await request(app)
      .get(`/secrets/${TEST_SECRET_KEY}/versions`)
      .expect(403);
  });

  it("requires authentication when OIDC is enabled", async () => {
    const { createServer } = await import("../index.js");
    const config = createOidcEnabledConfig();
    const app = createServer(config);

    await request(app)
      .post(`/secrets/${TEST_SECRET_KEY}/rotate`)
      .send({ value: "secret-value" })
      .expect(401);
  });
});

