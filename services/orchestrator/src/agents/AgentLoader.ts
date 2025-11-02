import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";

const AGENT_NAME_PATTERN = /^[a-z0-9_](?:[a-z0-9_-]{0,62}[a-z0-9_])?$/i;
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
  const { path: resolvedPath, safeName } = resolveAgentPath(name);
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
  if (path.basename(trimmed) !== trimmed) {
    throw new Error(`Invalid agent name segment: ${input}`);
  }
  return trimmed;
}

function isWithinBaseDirectory(baseDir: string, targetPath: string): boolean {
  const normalizedBase = path.resolve(baseDir);
  const normalizedTarget = path.resolve(targetPath);
  if (normalizedBase === normalizedTarget) {
    return false;
  }
  const relative = path.relative(normalizedBase, normalizedTarget);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveAgentPath(name: string): { path: string; safeName: string } {
  const safeName = sanitizeAgentName(name);

  for (const baseDir of AGENT_DIRECTORIES) {
    if (!fs.existsSync(baseDir)) {
      continue;
    }

    let realBase: string;
    try {
      realBase = fs.realpathSync(baseDir);
    } catch {
      continue;
    }

    const profilePath = path.join(realBase, safeName, "agent.md");
    if (!isWithinBaseDirectory(realBase, profilePath)) {
      continue;
    }

    if (!fs.existsSync(profilePath)) {
      continue;
    }

    try {
      const realCandidate = fs.realpathSync(profilePath);
      if (isWithinBaseDirectory(realBase, realCandidate)) {
        return { path: realCandidate, safeName };
      }
    } catch {
      continue;
    }
  }

  throw new Error(`Agent profile not found for ${name}`);
}
