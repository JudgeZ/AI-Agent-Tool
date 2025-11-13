import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PolicyDecision } from "./PolicyEnforcer.js";
import type { PolicyDecisionCache } from "./PolicyCache.js";
import type { PlanStep } from "../plan/planner.js";

type PolicyResult = { result: { allow?: boolean; deny?: unknown[] } };

const evaluateMock = vi.fn<(input: unknown) => PolicyResult[]>();
const setDataMock = vi.fn();

const loadPolicyMock = vi.fn(async () => ({
  evaluate: evaluateMock,
  setData: setDataMock
}));

vi.mock("@open-policy-agent/opa-wasm", () => ({
  loadPolicy: loadPolicyMock
}));

const loadAgentProfileMock = vi.fn();
const logAuditEventMock = vi.fn();

vi.mock("../agents/AgentLoader.js", () => ({
  loadAgentProfile: loadAgentProfileMock
}));

vi.mock("../observability/audit.js", () => ({
  logAuditEvent: logAuditEventMock
}));

type PolicyInput = {
  subject: { agent: string; capabilities: string[] };
  action: { capabilities: string[] };
};

function assertPolicyInput(input: unknown): asserts input is PolicyInput {
  if (!input || typeof input !== "object") {
    throw new Error("policy input was not captured");
  }
  const candidate = input as Record<string, unknown>;
  const subject = candidate.subject;
  const action = candidate.action;
  if (
    !subject ||
    typeof subject !== "object" ||
    typeof (subject as { agent?: unknown }).agent !== "string" ||
    !Array.isArray((subject as { capabilities?: unknown }).capabilities)
  ) {
    throw new Error("policy input subject missing capabilities");
  }
  if (
    !action ||
    typeof action !== "object" ||
    !Array.isArray((action as { capabilities?: unknown }).capabilities)
  ) {
    throw new Error("policy input action missing capabilities");
  }
}

describe("PolicyEnforcer", () => {
  let tempDir: string;
  let wasmPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "policy-enforcer-"));
    wasmPath = path.join(tempDir, "capabilities.wasm");
    writeFileSync(wasmPath, Buffer.from("wasm"));
    process.env.OPA_POLICY_WASM_PATH = wasmPath;

    evaluateMock.mockReset();
    evaluateMock.mockImplementation(() => [{ result: { allow: true, deny: [] } }]);
    setDataMock.mockReset();
    loadPolicyMock.mockClear();
    loadAgentProfileMock.mockReset();
    logAuditEventMock.mockReset();

    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.OPA_POLICY_WASM_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createEnforcer(options?: { cache?: PolicyDecisionCache | null }) {
    const module = await import("./PolicyEnforcer.js");
    const { PolicyEnforcer } = module;
    return new PolicyEnforcer(options);
  }

  function buildStep(partial?: Partial<PlanStep>): PlanStep {
    return {
      id: "s1",
      action: "apply_changes",
      capability: "repo.write",
      capabilityLabel: "Apply repository changes",
      labels: ["repo"],
      tool: "code_writer",
      timeoutSeconds: 60,
      approvalRequired: false,
      input: {},
      metadata: {},
      ...partial
    } satisfies PlanStep;
  }

  it("evaluates plan step capabilities through OPA", async () => {
    loadAgentProfileMock.mockReturnValue({
      name: "code-writer",
      role: "Code Writer",
      capabilities: ["repo.read", "repo.write"],
      approval_policy: {},
      constraints: [],
      body: ""
    });

    let receivedInput: unknown;
    evaluateMock.mockImplementation((input: unknown) => {
      receivedInput = input;
      return [{ result: { allow: true, deny: [] } }];
    });

    const enforcer = await createEnforcer();
    const step = buildStep();

    const decision = await enforcer.enforcePlanStep(step, {
      planId: "plan-550e8400-e29b-41d4-a716-446655440000",
      traceId: "trace-abc",
      approvals: { "repo.write": true }
    });

    expect(decision.allow).toBe(true);
    assertPolicyInput(receivedInput);
    expect(receivedInput.subject.capabilities).toContain("repo.write");
    expect(receivedInput.action.capabilities).toEqual(["repo.write"]);
    expect(loadPolicyMock).toHaveBeenCalledTimes(1);
  }, 15000);

  it("throws when the policy returns no decision", async () => {
    loadAgentProfileMock.mockReturnValue({
      name: "code-writer",
      role: "Code Writer",
      capabilities: ["repo.read", "repo.write"],
      approval_policy: {},
      constraints: [],
      body: ""
    });

    evaluateMock.mockImplementation(() => []);

    const enforcer = await createEnforcer();

    await expect(
      enforcer.enforcePlanStep(buildStep(), {
        planId: "plan-empty",
        traceId: "trace-empty",
      })
    ).rejects.toThrow("OPA policy returned no decision");
  });

  it("returns deny reasons from the policy", async () => {
    loadAgentProfileMock.mockReturnValue({
      name: "code-writer",
      role: "Code Writer",
      capabilities: ["repo.read", "repo.write"],
      approval_policy: {},
      constraints: [],
      body: ""
    });

    evaluateMock.mockImplementation(() => [
      {
        result: {
          allow: false,
          deny: [{ reason: "missing_capability", capability: "repo.write" }]
        }
      }
    ]);

    const enforcer = await createEnforcer();
    const decision = await enforcer.enforcePlanStep(buildStep(), {
      planId: "plan-12345678-9abc-4def-8abc-1234567890ab",
      traceId: "trace-deny"
    });

    expect(decision.allow).toBe(false);
    expect(decision.deny).toEqual([{ reason: "missing_capability", capability: "repo.write" }]);
  });

  it("throws a policy violation when the agent profile is missing", async () => {
    loadAgentProfileMock.mockImplementation(() => {
      throw new Error("missing profile");
    });

    const enforcer = await createEnforcer();

    await expect(
      enforcer.enforcePlanStep(buildStep(), {
        planId: "plan-00112233-4455-4677-8899-aabbccddeeff",
        traceId: "trace-fallback"
      })
    ).rejects.toMatchObject({
      name: "PolicyViolationError",
      details: [{ reason: "agent_profile_missing", capability: "repo.write" }]
    });
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agent.profile.load",
        outcome: "denied",
        agent: "code-writer",
        resource: "agent.profile",
        details: expect.objectContaining({ error: "missing profile" })
      })
    );
  });

  it("loads the policy once and reuses it", async () => {
    loadAgentProfileMock.mockReturnValue({
      name: "code-writer",
      role: "Code Writer",
      capabilities: ["repo.read", "repo.write"],
      approval_policy: {},
      constraints: [],
      body: ""
    });

    const enforcer = await createEnforcer();
    await enforcer.enforcePlanStep(buildStep(), {
      planId: "plan-12345678-1234-1234-1234-1234567890ab",
    });
    await enforcer.enforcePlanStep(buildStep({ id: "s2" }), {
      planId: "plan-12345678-1234-1234-1234-1234567890ab",
    });

    expect(loadPolicyMock).toHaveBeenCalledTimes(1);
  });

  it("evaluates http actions with provided capabilities", async () => {
    loadAgentProfileMock.mockImplementation(name => ({
      name,
      role: "Planner",
      capabilities: ["plan.create"],
      approval_policy: {},
      constraints: [],
      body: ""
    }));

    let receivedInput: unknown;
    evaluateMock.mockImplementation((input: unknown) => {
      receivedInput = input;
      return [{ result: { allow: true, deny: [] } }];
    });

    const enforcer = await createEnforcer();
    const decision = await enforcer.enforceHttpAction({
      action: "http.post.plan",
      requiredCapabilities: ["plan.create"],
      agent: "planner",
      traceId: "trace-http"
    });

    expect(decision.allow).toBe(true);
    assertPolicyInput(receivedInput);
    expect(receivedInput.action.capabilities).toEqual(["plan.create"]);
    expect(receivedInput.subject.agent).toBe("planner");
  });

  it("defaults http action agent to planner when none is provided", async () => {
    loadAgentProfileMock.mockImplementation(name => ({
      name,
      role: "Planner",
      capabilities: ["plan.create"],
      approval_policy: {},
      constraints: [],
      body: ""
    }));

    const enforcer = await createEnforcer();
    await enforcer.enforceHttpAction({
      action: "http.post.plan",
      requiredCapabilities: ["plan.create"],
    });

    expect(loadAgentProfileMock).toHaveBeenCalledWith("planner");
  });

  it("throws when the http action agent profile cannot be loaded", async () => {
    loadAgentProfileMock.mockImplementation(() => {
      throw new Error("missing profile");
    });

    const enforcer = await createEnforcer();

    await expect(
      enforcer.enforceHttpAction({
        action: "http.post.plan",
        requiredCapabilities: ["plan.create"],
        agent: "planner",
        traceId: "trace-http"
      })
    ).rejects.toMatchObject({
      name: "PolicyViolationError",
      details: [{ reason: "agent_profile_missing", capability: "plan.create" }]
    });
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agent.profile.load",
        outcome: "denied",
        agent: "planner",
        resource: "agent.profile",
      })
    );
  });

  it("applies runtime role mappings to the policy data", async () => {
    process.env.OIDC_ENABLED = "true";
    process.env.OIDC_ISSUER_URL = "https://issuer.example.com";
    process.env.OIDC_CLIENT_ID = "policy-client";
    process.env.OIDC_CLIENT_SECRET = "policy-secret";
    process.env.OIDC_ROLE_MAPPINGS = JSON.stringify({ engineer: ["repo.write"] });

    const enforcer = await createEnforcer();
    loadAgentProfileMock.mockReturnValue({
      name: "code-writer",
      role: "Code Writer",
      capabilities: ["repo.read", "repo.write"],
      approval_policy: {},
      constraints: [],
      body: ""
    });

    await enforcer.enforcePlanStep(buildStep(), {
      planId: "plan-abcdefab-cdef-4abc-8def-abcdefabcdef",
      traceId: "trace-role",
    });

    expect(setDataMock).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilities: expect.objectContaining({
          role_bindings: { engineer: ["repo.write"] }
        })
      })
    );

    delete process.env.OIDC_ENABLED;
    delete process.env.OIDC_ISSUER_URL;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;
    delete process.env.OIDC_ROLE_MAPPINGS;
  });

  it("uses the provided cache for repeated evaluations", async () => {
    loadAgentProfileMock.mockReturnValue({
      name: "code-writer",
      role: "Code Writer",
      capabilities: ["repo.read", "repo.write"],
      approval_policy: {},
      constraints: [],
      body: ""
    });

    const cacheStore: { value: PolicyDecision | null } = { value: null };
    const cache: PolicyDecisionCache = {
      get: vi.fn(async () => cacheStore.value),
      set: vi.fn(async (_key: string, decision: PolicyDecision) => {
        cacheStore.value = decision;
      })
    };

    const enforcer = await createEnforcer({ cache });
    await enforcer.enforcePlanStep(buildStep(), {
      planId: "plan-cache",
      traceId: "trace-cache"
    });
    expect(cache.get).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledTimes(1);

    evaluateMock.mockClear();

    const decision = await enforcer.enforcePlanStep(buildStep(), {
      planId: "plan-cache",
      traceId: "trace-cache"
    });

    expect(decision.allow).toBe(true);
    expect(cache.get).toHaveBeenCalledTimes(2);
    expect(cache.set).toHaveBeenCalledTimes(1);
    expect(evaluateMock).not.toHaveBeenCalled();
  });
});

