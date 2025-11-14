import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionStore } from "../auth/SessionStore.js";
import { loadConfig, type AppConfig } from "../config.js";

const createPlanMock = vi.fn();
const submitPlanStepsMock = vi.fn();

const policyMock = {
  enforceHttpAction: vi.fn(),
};

vi.mock("../plan/index.js", () => ({
  createPlan: (...args: unknown[]) => createPlanMock(...args),
}));

vi.mock("../queue/PlanQueueRuntime.js", () => ({
  submitPlanSteps: (...args: unknown[]) => submitPlanStepsMock(...args),
  getPlanSubject: vi.fn(),
  getPersistedPlanStep: vi.fn(),
  resolvePlanStepApproval: vi.fn(),
}));

vi.mock("../policy/PolicyEnforcer.js", () => ({
  getPolicyEnforcer: () => policyMock,
}));

async function createServer(config?: AppConfig) {
  const module = await import("./app.js");
  return module.createServer(config);
}

function buildConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig();
  return {
    ...base,
    ...overrides,
    auth: {
      ...base.auth,
      ...overrides.auth,
      oidc: {
        ...base.auth.oidc,
        ...overrides.auth?.oidc,
      },
    },
    server: {
      ...base.server,
      ...overrides.server,
      rateLimits: {
        ...base.server.rateLimits,
        ...overrides.server?.rateLimits,
      },
    },
  } satisfies AppConfig;
}

describe("POST /plan security", () => {
  beforeEach(() => {
    createPlanMock.mockReset();
    createPlanMock.mockResolvedValue({
      id: "plan-123",
      goal: "test goal",
      steps: [
        {
          id: "step-1",
          action: "noop",
          capability: "plan.read",
          capabilityLabel: "Read plan",
          labels: [],
          tool: "noop",
          timeoutSeconds: 0,
          approvalRequired: false,
          input: {},
          metadata: {},
        },
      ],
      successCriteria: ["done"],
    });
    submitPlanStepsMock.mockReset();
    submitPlanStepsMock.mockResolvedValue(undefined);
    policyMock.enforceHttpAction.mockReset();
    policyMock.enforceHttpAction.mockResolvedValue({ allow: true, deny: [] });
    sessionStore.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    sessionStore.clear();
  });

  it("returns 401 when OIDC is enabled and no session is present", async () => {
    const config = buildConfig({
      auth: {
        oidc: {
          enabled: true,
        },
      },
    });

    const app = await createServer(config);

    const response = await request(app)
      .post("/plan")
      .send({ goal: "Ship it" })
      .expect(401);

    expect(response.body).toMatchObject({
      code: "unauthorized",
      message: "authentication required",
    });
    expect(policyMock.enforceHttpAction).not.toHaveBeenCalled();
    expect(createPlanMock).not.toHaveBeenCalled();
    expect(submitPlanStepsMock).not.toHaveBeenCalled();
  });

  it("returns 403 and deny details when policy rejects plan creation", async () => {
    const denyDetails = [{ reason: "agent_profile_missing", capability: "plan.create" }];
    policyMock.enforceHttpAction.mockResolvedValueOnce({ allow: false, deny: denyDetails });

    const app = await createServer(buildConfig());

    const response = await request(app)
      .post("/plan")
      .send({ goal: "Ship it" })
      .expect(403);

    expect(response.body).toMatchObject({
      code: "forbidden",
      details: denyDetails,
      message: "plan.create denied",
    });
    expect(policyMock.enforceHttpAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "http.post.plan",
        requiredCapabilities: ["plan.create"],
      }),
    );
    expect(createPlanMock).not.toHaveBeenCalled();
    expect(submitPlanStepsMock).not.toHaveBeenCalled();
  });
});

