import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadPolicy } from "@open-policy-agent/opa-wasm";

import { loadAgentProfile, type AgentProfile } from "../agents/AgentLoader.js";
import { loadConfig } from "../config.js";
import type { PlanStep } from "../plan/planner.js";
import type { AppConfig } from "../config.js";
import { logAuditEvent } from "../observability/audit.js";

export type DenyReason = {
  reason: string;
  capability?: string;
};

export type PolicyDecision = {
  allow: boolean;
  deny: DenyReason[];
};

export class PolicyViolationError extends Error {
  readonly status: number;
  readonly details: DenyReason[];

  constructor(message: string, details: DenyReason[], status = 403) {
    super(message);
    this.name = "PolicyViolationError";
    this.status = status;
    this.details = details;
  }
}

type EvaluatablePolicy = {
  evaluate: (input: unknown) => unknown;
  setData: (data: unknown) => Promise<void> | void;
};

type WasmPolicy = {
  policy: EvaluatablePolicy;
  wasmPath: string;
  dataPath?: string;
  data?: unknown;
};

type SubjectContext = {
  tenant?: string;
  roles?: string[];
  scopes?: string[];
  sessionId?: string;
  user?: {
    id?: string;
    email?: string;
    name?: string;
  };
};

type PolicyRuntimeData = {
  capabilities?: {
    role_bindings?: Record<string, string[]>;
    tenant_role_bindings?: Record<string, Record<string, string[]>>;
  };
};

type PlanStepContext = {
  planId: string;
  traceId?: string;
  approvals?: Record<string, boolean>;
  subject?: SubjectContext;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRoleMappings(
  mappings: Record<string, string[]>,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [role, caps] of Object.entries(mappings)) {
    result[role] = [...caps];
  }
  return result;
}

function cloneTenantRoleMappings(
  mappings: Record<string, Record<string, string[]>>,
): Record<string, Record<string, string[]>> {
  const result: Record<string, Record<string, string[]>> = {};
  for (const [tenant, roles] of Object.entries(mappings)) {
    result[tenant] = cloneRoleMappings(roles);
  }
  return result;
}

function buildRuntimePolicyData(config: AppConfig): PolicyRuntimeData {
  const roles = config.auth.oidc.roles;
  const capabilities: PolicyRuntimeData["capabilities"] = {};
  if (Object.keys(roles.mappings).length > 0) {
    capabilities.role_bindings = cloneRoleMappings(roles.mappings);
  }
  if (Object.keys(roles.tenantMappings).length > 0) {
    capabilities.tenant_role_bindings = cloneTenantRoleMappings(
      roles.tenantMappings,
    );
  }
  return Object.keys(capabilities).length > 0 ? { capabilities } : {};
}

function mergePolicyData(base: unknown, runtime: PolicyRuntimeData): unknown {
  const baseRecord = isRecord(base) ? { ...base } : {};
  if (!runtime.capabilities) {
    return baseRecord;
  }
  const baseCapabilities = isRecord(baseRecord.capabilities)
    ? { ...(baseRecord.capabilities as Record<string, unknown>) }
    : {};

  if (runtime.capabilities.role_bindings) {
    baseCapabilities.role_bindings = {
      ...(isRecord(baseCapabilities.role_bindings)
        ? cloneRoleMappings(
            baseCapabilities.role_bindings as Record<string, string[]>,
          )
        : {}),
      ...cloneRoleMappings(runtime.capabilities.role_bindings),
    };
  }

  if (runtime.capabilities.tenant_role_bindings) {
    const existingTenantMappings = isRecord(
      baseCapabilities.tenant_role_bindings,
    )
      ? (baseCapabilities.tenant_role_bindings as Record<
          string,
          Record<string, string[]>
        >)
      : {};
    const mergedTenantMappings: Record<
      string,
      Record<string, string[]>
    > = cloneTenantRoleMappings(existingTenantMappings);
    for (const [tenant, mapping] of Object.entries(
      runtime.capabilities.tenant_role_bindings,
    )) {
      mergedTenantMappings[tenant] = cloneRoleMappings(mapping);
    }
    baseCapabilities.tenant_role_bindings = mergedTenantMappings;
  }

  return {
    ...baseRecord,
    capabilities: baseCapabilities,
  };
}

function hasRuntimePolicyData(runtime: PolicyRuntimeData): boolean {
  if (!runtime.capabilities) {
    return false;
  }
  const roleBindings = runtime.capabilities.role_bindings ?? {};
  const tenantBindings = runtime.capabilities.tenant_role_bindings ?? {};
  return (
    Object.keys(roleBindings).length > 0 ||
    Object.keys(tenantBindings).length > 0
  );
}

const cachedProfiles = new Map<string, AgentProfile>();

function toolToAgentDirectory(tool: string): string {
  return tool.replace(/_/g, "-");
}

function resolvePolicyCandidates(): string[] {
  const explicit = process.env.OPA_POLICY_WASM_PATH;
  const candidates = [
    explicit,
    path.resolve(process.cwd(), "policies", "capabilities.wasm"),
    path.resolve(
      process.cwd(),
      "services",
      "orchestrator",
      "policies",
      "capabilities.wasm",
    ),
    path.resolve(
      __dirname,
      "../../../../infra/policies/dist/capabilities.wasm",
    ),
  ];
  return candidates.filter((value): value is string => Boolean(value));
}

function resolvePolicyDataCandidates(wasmPath: string): string[] {
  const explicit = process.env.OPA_POLICY_DATA_PATH;
  const baseDir = path.dirname(wasmPath);
  const candidates = [explicit, path.join(baseDir, "data.json")];
  return candidates.filter((value): value is string => Boolean(value));
}

async function loadWasmPolicy(): Promise<WasmPolicy> {
  const wasmPath = resolvePolicyCandidates().find((candidate) =>
    existsSync(candidate),
  );
  if (!wasmPath) {
    throw new Error(
      "OPA policy bundle not found. Set OPA_POLICY_WASM_PATH or run `make opa-build` to generate it.",
    );
  }

  const wasm = await readFile(wasmPath);
  const policy = (await loadPolicy(wasm)) as EvaluatablePolicy;

  let policyData: unknown;
  const dataPath = resolvePolicyDataCandidates(wasmPath).find((candidate) =>
    existsSync(candidate),
  );
  if (dataPath) {
    const raw = await readFile(dataPath, "utf-8");
    policyData = JSON.parse(raw);
    await Promise.resolve(policy.setData(policyData));
  }

  return { policy, wasmPath, dataPath, data: policyData };
}

function normalizeDeny(deny: unknown): DenyReason[] {
  if (!Array.isArray(deny)) {
    return [];
  }
  return deny
    .map((item) => {
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const reason =
          typeof record.reason === "string" ? record.reason : "unknown";
        const capability =
          typeof record.capability === "string" ? record.capability : undefined;
        return { reason, capability } satisfies DenyReason;
      }
      if (typeof item === "string") {
        return { reason: item } satisfies DenyReason;
      }
      return { reason: "unknown" } satisfies DenyReason;
    })
    .filter((entry): entry is DenyReason => Boolean(entry));
}

let singleton: PolicyEnforcer | null = null;

export function getPolicyEnforcer(): PolicyEnforcer {
  if (!singleton) {
    singleton = new PolicyEnforcer();
  }
  return singleton;
}

export class PolicyEnforcer {
  private readonly runMode: string;
  private readonly runtimePolicyData: PolicyRuntimeData;
  private loading: Promise<WasmPolicy> | null = null;
  private loaded: WasmPolicy | null = null;
  private policyDataApplied = false;

  constructor() {
    const config = loadConfig();
    this.runMode = config.runMode;
    this.runtimePolicyData = buildRuntimePolicyData(config);
  }

  async enforcePlanStep(
    step: PlanStep,
    context: PlanStepContext,
  ): Promise<PolicyDecision> {
    const agentName = toolToAgentDirectory(step.tool);
    const profile = this.resolveProfile(agentName, [step.capability]);
    const approvals = context.approvals ?? {};
    const actionRunMode =
      typeof step.metadata?.requiredRunMode === "string"
        ? step.metadata.requiredRunMode
        : "any";
    const tenantId = context.subject?.tenant;
    const userInfo = context.subject?.user;
    const roles = context.subject?.roles ?? [];
    const scopes = context.subject?.scopes ?? [];
    const sessionId = context.subject?.sessionId;

    const input = {
      subject: {
        agent: profile.name,
        tool: step.tool,
        capabilities: profile.capabilities,
        approvals,
        run_mode: this.runMode,
        tenant_id: tenantId,
        user: userInfo,
        roles,
        scopes,
        session_id: sessionId,
      },
      action: {
        type: "plan.step",
        plan_id: context.planId,
        step_id: step.id,
        capabilities: [step.capability],
        run_mode: actionRunMode,
      },
      context: {
        trace_id: context.traceId,
        approvals,
        tenant_id: tenantId,
        roles,
        scopes,
        session_id: sessionId,
      },
    };

    return this.evaluate(input);
  }

  private async evaluate(
    input: Record<string, unknown>,
  ): Promise<PolicyDecision> {
    const policy = await this.getPolicy();
    await this.applyRuntimePolicyData(policy);
    const result = policy.policy.evaluate(input);
    if (!Array.isArray(result) || result.length === 0) {
      throw new Error("OPA policy returned no decision");
    }
    const output = result[0]?.result as Record<string, unknown> | undefined;
    const allow = Boolean(output?.allow);
    const deny = normalizeDeny(output?.deny);
    return { allow, deny };
  }

  async enforceHttpAction(options: {
    action: string;
    requiredCapabilities: string[];
    agent?: string;
    traceId?: string;
    runMode?: string;
    subject?: SubjectContext;
  }): Promise<PolicyDecision> {
    const agentDirectory = this.normalizeAgentName(options.agent);
    const profile = this.resolveProfile(
      agentDirectory,
      options.requiredCapabilities,
    );
    const tenantId = options.subject?.tenant;
    const userInfo = options.subject?.user;
    const roles = options.subject?.roles ?? [];
    const scopes = options.subject?.scopes ?? [];
    const sessionId = options.subject?.sessionId;

    const input = {
      subject: {
        agent: profile.name,
        tool: agentDirectory,
        capabilities: profile.capabilities,
        approvals: {},
        run_mode: this.runMode,
        tenant_id: tenantId,
        user: userInfo,
        roles,
        scopes,
        session_id: sessionId,
      },
      action: {
        type: options.action,
        capabilities: options.requiredCapabilities,
        run_mode: options.runMode ?? "any",
      },
      context: {
        trace_id: options.traceId,
        tenant_id: tenantId,
        roles,
        scopes,
        session_id: sessionId,
      },
    };

    return this.evaluate(input);
  }

  private normalizeAgentName(agent?: string): string {
    if (!agent || agent.trim().length === 0) {
      return "planner";
    }
    return toolToAgentDirectory(agent.trim().toLowerCase());
  }

  private resolveProfile(
    name: string,
    fallbackCapabilities: string[],
  ): AgentProfile {
    const key = name;
    const cached = cachedProfiles.get(key);
    if (cached) {
      return cached;
    }

    let profile: AgentProfile;
    try {
      profile = loadAgentProfile(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const denyDetails: DenyReason[] = fallbackCapabilities.length
        ? fallbackCapabilities.map((capability) => ({
            reason: "agent_profile_missing",
            capability,
          }))
        : [{ reason: "agent_profile_missing" }];
      logAuditEvent({
        action: "agent.profile.load",
        outcome: "denied",
        agent: name,
        resource: "agent.profile",
        details: {
          error: message,
          capabilities: fallbackCapabilities,
        },
      });
      throw new PolicyViolationError(
        `Unable to load agent profile for ${name}`,
        denyDetails,
      );
    }
    cachedProfiles.set(key, profile);
    return profile;
  }

  private async getPolicy(): Promise<WasmPolicy> {
    if (this.loaded) {
      return this.loaded;
    }
    if (!this.loading) {
      this.loading = loadWasmPolicy().then((policy) => {
        this.loaded = policy;
        this.loading = null;
        return policy;
      });
    }
    return this.loading;
  }

  private async applyRuntimePolicyData(policy: WasmPolicy): Promise<void> {
    if (this.policyDataApplied) {
      return;
    }
    if (!hasRuntimePolicyData(this.runtimePolicyData)) {
      this.policyDataApplied = true;
      return;
    }
    const merged = mergePolicyData(policy.data, this.runtimePolicyData);
    await Promise.resolve(policy.policy.setData(merged));
    policy.data = merged;
    this.policyDataApplied = true;
  }
}
