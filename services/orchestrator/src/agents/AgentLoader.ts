import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";

const AGENT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-_]{0,62}[a-z0-9])?$/i;
const AGENT_DIRECTORIES = [
  path.resolve(process.cwd(), "agents"),
  path.resolve(process.cwd(), "..", "agents"),
  path.resolve(__dirname, "../../../../agents")
];

export type AgentProfile = {
  name: string;
  role: string;
  capabilities: string[];
  approval_policy?: Record<string, string>;
  model?: { provider?: string; routing?: string; temperature?: number };
  constraints?: string[];
  body?: string;
};

export function loadAgentProfile(name: string): AgentProfile {
  const safeName = sanitizeAgentName(name);
  const resolvedPath = resolveAgentPath(safeName);
  const raw = fs.readFileSync(resolvedPath, "utf-8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/m.exec(raw);
  let meta: Record<string, unknown> = {};
  let body = raw;
  if (m) {
    const yaml = m[1];
    body = m[2];
    const parsed = parseYaml(yaml);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>;
    }
  }
  const capabilities = normalizeStringArray(meta.capabilities, ["repo.read"]);
  const approvalPolicy = normalizeStringRecord(meta.approval_policy);
  const model = normalizeModel(meta.model);
  const constraints = normalizeStringArray(meta.constraints, []);
  return {
    name: typeof meta.name === "string" ? meta.name : safeName,
    role: typeof meta.role === "string" ? meta.role : "Agent",
    capabilities,
    approval_policy: approvalPolicy,
    model,
    constraints,
    body,
  };
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "string") {
    return [value];
  }
  return fallback;
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v)])
    );
  }
  return {};
}

function normalizeModel(value: unknown): AgentProfile["model"] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const model: AgentProfile["model"] = {};
    if (typeof record.provider === "string") {
      model.provider = record.provider;
    }
    if (typeof record.routing === "string") {
      model.routing = record.routing;
    }
    const temperature = record.temperature;
    if (typeof temperature === "number") {
      model.temperature = temperature;
    } else if (typeof temperature === "string") {
      const parsed = Number(temperature);
      if (!Number.isNaN(parsed)) {
        model.temperature = parsed;
      }
    }
    return model;
  }
  return {};
}

function sanitizeAgentName(input: string): string {
  const trimmed = input.trim();
  if (!AGENT_NAME_PATTERN.test(trimmed)) {
    throw new Error(`Invalid agent name: ${input}`);
  }
  return trimmed;
}

function isWithinBaseDirectory(baseDir: string, targetPath: string): boolean {
  const relative = path.relative(baseDir, targetPath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveAgentPath(name: string): string {
  const safeName = sanitizeAgentName(name);

  for (const baseDir of AGENT_DIRECTORIES) {
    if (!fs.existsSync(baseDir)) {
      continue;
    }
    const candidate = path.resolve(baseDir, safeName, "agent.md");
    if (!isWithinBaseDirectory(baseDir, candidate)) {
      continue;
    }
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      const realBase = fs.realpathSync(baseDir);
      const realCandidate = fs.realpathSync(candidate);
      if (isWithinBaseDirectory(realBase, realCandidate)) {
        return realCandidate;
      }
    } catch {
      // Ignore and continue searching other directories
    }
  }

  throw new Error(`Agent profile not found for ${name}`);
}
