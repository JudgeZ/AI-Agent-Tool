import fs from "fs";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAgentProfile } from "../AgentLoader";

const TEMPLATE_AGENT_NAME = "__template_agent__";
const TEMPLATE_SOURCE = findTemplateSource();
const TEMPLATE_DEST_DIR = path.join(process.cwd(), "agents", TEMPLATE_AGENT_NAME);
const TEMPLATE_DEST_FILE = path.join(TEMPLATE_DEST_DIR, "agent.md");
const STRING_AGENT_NAME = "__string_agent__";
const STRING_AGENT_DIR = path.join(process.cwd(), "agents", STRING_AGENT_NAME);
const STRING_AGENT_FILE = path.join(STRING_AGENT_DIR, "agent.md");

describe("loadAgentProfile", () => {
  beforeAll(() => {
    fs.mkdirSync(TEMPLATE_DEST_DIR, { recursive: true });
    const templateContents = fs.readFileSync(TEMPLATE_SOURCE, "utf-8");
    fs.writeFileSync(TEMPLATE_DEST_FILE, templateContents);

    fs.mkdirSync(STRING_AGENT_DIR, { recursive: true });
    fs.writeFileSync(
      STRING_AGENT_FILE,
      `---
name: string-agent
role: Helper
capabilities: repo.write
approval_policy:
  repo.write: require_review
model:
  provider: anthropic
  routing: low_cost
  temperature: "0.65"
constraints: enforce logging
---
# Agent
Always log actions.
`,
    );
  });

  afterAll(() => {
    if (fs.existsSync(TEMPLATE_DEST_DIR)) {
      fs.rmSync(TEMPLATE_DEST_DIR, { recursive: true, force: true });
    }
    const agentsDir = path.dirname(TEMPLATE_DEST_DIR);
    if (fs.existsSync(agentsDir) && fs.readdirSync(agentsDir).length === 0) {
      fs.rmdirSync(agentsDir);
    }
    if (fs.existsSync(STRING_AGENT_DIR)) {
      fs.rmSync(STRING_AGENT_DIR, { recursive: true, force: true });
      const maybeAgentsDir = path.dirname(STRING_AGENT_DIR);
      if (fs.existsSync(maybeAgentsDir) && fs.readdirSync(maybeAgentsDir).length === 0) {
        fs.rmdirSync(maybeAgentsDir);
      }
    }
  });

  it("parses multi-line YAML front matter fields", () => {
    const profile = loadAgentProfile(TEMPLATE_AGENT_NAME);

    expect(profile.name).toBe("code-writer");
    expect(profile.role).toBe("Code Writer");
    expect(profile.capabilities).toEqual([
      "repo.read",
      "repo.write",
      "test.run",
      "plan.read",
    ]);
    expect(profile.approval_policy).toEqual({
      "repo.write": "human_approval",
      "network.egress": "deny",
    });
    expect(profile.model).toEqual({
      provider: "auto",
      routing: "balanced",
      temperature: 0.2,
    });
    expect(profile.constraints).toEqual([
      "Prioritize reliability and test coverage over speed",
      "Never bypass security gates",
      "Capture diffs and test results in the plan timeline",
    ]);
    expect(profile.body).toContain("# Agent Guide");
  });

  it("normalizes scalar fields into arrays and numbers", () => {
    const profile = loadAgentProfile(STRING_AGENT_NAME);

    expect(profile.capabilities).toEqual(["repo.write"]);
    expect(profile.approval_policy).toEqual({ "repo.write": "require_review" });
    expect(profile.model).toEqual({
      provider: "anthropic",
      routing: "low_cost",
      temperature: 0.65,
    });
    expect(profile.constraints).toEqual(["enforce logging"]);
    expect(profile.body).toContain("Always log actions.");
  });

  it("rejects unsafe agent names", () => {
    expect(() => loadAgentProfile("../code-writer")).toThrow(/Invalid agent name/);
    expect(() => loadAgentProfile("bad name!")).toThrow(/Invalid agent name/);
  });

  it("throws when the agent profile cannot be found", () => {
    expect(() => loadAgentProfile("__missing_agent__")).toThrow(/Agent profile not found/);
  });
});

function findTemplateSource(): string {
  const candidateRoots = [
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "../.."),
  ];
  for (const root of candidateRoots) {
    const candidate = path.join(root, "docs", "agents", "templates", "agent.md");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("Unable to locate docs/agents/templates/agent.md");
}
