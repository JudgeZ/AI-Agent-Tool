#!/usr/bin/env node
import fs from "fs";
import path from "path";

import { runPlan } from "./commands/plan";

function usage() {
  console.log(`oss-ai-agent-tool CLI
Usage:
  aidt new-agent <name>           Create agents/<name>/agent.md from template
  aidt plan <goal...>             Create a plan under .plans/
`);
}

function normalizeAgentName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Agent name is required");
  }
  if (/[\\/]/.test(trimmed)) {
    throw new Error("Agent name must not contain path separators");
  }
  if (trimmed.includes("..")) {
    throw new Error("Agent name must not contain '..'");
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error("Agent name must not be '.' or '..'");
  }
  if (trimmed.includes(":")) {
    throw new Error("Agent name must not contain ':'");
  }
  if (path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed) || path.posix.isAbsolute(trimmed)) {
    throw new Error("Agent name must be a relative path segment");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(trimmed)) {
    throw new Error("Agent name may only include alphanumeric characters, '-' or '_'");
  }
  return trimmed;
}

async function newAgent(name: string) {
  const normalized = normalizeAgentName(name);
  const repoRoot = process.cwd();
  const agentsRoot = path.resolve(repoRoot, "agents");
  const dir = path.resolve(agentsRoot, normalized);
  const relativeToAgents = path.relative(agentsRoot, dir);
  if (relativeToAgents.startsWith("..") || path.isAbsolute(relativeToAgents)) {
    throw new Error(`Refusing to write outside agents directory: ${normalized}`);
  }

  const file = path.join(dir, "agent.md");
  const templatePath = path.join(repoRoot, "docs", "agents", "templates", "agent.md");
  if (!fs.existsSync(templatePath)) {
    console.error("Template not found:", templatePath);
    process.exit(1);
  }
  fs.mkdirSync(agentsRoot, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const tpl = fs
    .readFileSync(templatePath, "utf-8")
    .replace('name: "code-writer"', `name: "${normalized}"`);
  fs.writeFileSync(file, tpl, "utf-8");
  console.log("Created", file);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "new-agent") {
    if (!rest[0]) return usage();
    await newAgent(rest[0]);
    return;
  }
  if (cmd === "plan") {
    const goal = rest.join(" ").trim() || "General improvement";
    await runPlan(goal);
    return;
  }
  usage();
}

main().catch(e => { console.error(e); process.exit(1); });
