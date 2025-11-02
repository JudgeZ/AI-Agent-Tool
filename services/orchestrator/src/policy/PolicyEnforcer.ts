import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadPolicy } from "@open-policy-agent/opa-wasm";

import { loadAgentProfile, type AgentProfile } from "../agents/AgentLoader.js";
import { loadConfig } from "../config.js";
import type { PlanStep } from "../plan/planner.js";

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
};

type PlanStepContext = {
  planId: string;
  traceId?: string;
  approvals?: Record<string, boolean>;
};

const cachedProfiles = new Map<string, AgentProfile>();

function toolToAgentDirectory(tool: string): string {
  return tool.replace(/_/g, "-");
}

function resolvePolicyCandidates(): string[] {
  const explicit = process.env.OPA_POLICY_WASM_PATH;
  const candidates = [
    explicit,
    path.resolve(process.cwd(), "policies", "capabilities.wasm"),
    path.resolve(process.cwd(), "services", "orchestrator", "policies", "capabilities.wasm"),
    path.resolve(__dirname, "../../../../infra/policies/dist/capabilities.wasm")
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
  const wasmPath = resolvePolicyCandidates().find(candidate => existsSync(candidate));
  if (!wasmPath) {
    throw new Error("OPA policy bundle not found. Set OPA_POLICY_WASM_PATH or run `make opa-build` to generate it.");
  }

  const wasm = await readFile(wasmPath);
  const policy = (await loadPolicy(wasm)) as EvaluatablePolicy;

  const dataPath = resolvePolicyDataCandidates(wasmPath).find(candidate => existsSync(candidate));
  if (dataPath) {
    const raw = await readFile(dataPath, "utf-8");
    const data = JSON.parse(raw);
    await Promise.resolve(policy.setData(data));
  }

  return { policy, wasmPath, dataPath };
}

function normalizeDeny(deny: unknown): DenyReason[] {
  if (!Array.isArray(deny)) {
    return [];
  }
  return deny
    .map(item => {
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const reason = typeof record.reason === "string" ? record.reason : "unknown";
        const capability = typeof record.capability === "string" ? record.capability : undefined;
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
  private loading: Promise<WasmPolicy> | null = null;
  private loaded: WasmPolicy | null = null;

  constructor() {
    const config = loadConfig();
    this.runMode = config.runMode;
  }

  async enforcePlanStep(step: PlanStep, context: PlanStepContext): Promise<PolicyDecision> {
    const agentName = toolToAgentDirectory(step.tool);
    const profile = this.resolveProfile(agentName, [step.capability]);
    const approvals = context.approvals ?? {};
    const actionRunMode = typeof step.metadata?.requiredRunMode === "string" ? step.metadata.requiredRunMode : "any";

    const input = {
      subject: {
        agent: profile.name,
        tool: step.tool,
        capabilities: profile.capabilities,
        approvals,
        run_mode: this.runMode
      },
      action: {
        type: "plan.step",
        plan_id: context.planId,
        step_id: step.id,
        capabilities: [step.capability],
        run_mode: actionRunMode
      },
      traceId: context.traceId
    };

    return this.evaluate(input);
  }

  private async evaluate(input: Record<string, unknown>): Promise<PolicyDecision> {
    const policy = await this.getPolicy();
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
  }): Promise<PolicyDecision> {
    const agentDirectory = this.normalizeAgentName(options.agent);
    const profile = this.resolveProfile(agentDirectory, options.requiredCapabilities);

    const input = {
      subject: {
        agent: profile.name,
        tool: agentDirectory,
        capabilities: profile.capabilities,
        approvals: {},
        run_mode: this.runMode
      },
      action: {
        type: options.action,
        capabilities: options.requiredCapabilities,
        run_mode: options.runMode ?? "any"
      },
      traceId: options.traceId
    };

    return this.evaluate(input);
  }

  private normalizeAgentName(agent?: string): string {
    if (!agent || agent.trim().length === 0) {
      return "planner";
    }
    return toolToAgentDirectory(agent.trim().toLowerCase());
  }

  private resolveProfile(name: string, fallbackCapabilities: string[]): AgentProfile {
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
      // eslint-disable-next-line no-console
      console.warn(`[policy] Falling back to provided capabilities for agent ${name}: ${message}`);
      profile = {
        name,
        role: "Fallback agent",
        capabilities: fallbackCapabilities,
        approval_policy: {},
        constraints: [],
        body: ""
      };
    }
    cachedProfiles.set(key, profile);
    return profile;
  }

  private async getPolicy(): Promise<WasmPolicy> {
    if (this.loaded) {
      return this.loaded;
    }
    if (!this.loading) {
      this.loading = loadWasmPolicy().then(policy => {
        this.loaded = policy;
        this.loading = null;
        return policy;
      });
    }
    return this.loading;
  }
}

