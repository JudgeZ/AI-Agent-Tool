#!/usr/bin/env node
import fs from "fs";
import path from "path";

import { runPlan } from "./commands/plan";
import { logger } from "./logger";
import { printErrorLine, printLine } from "./output";

function usage() {
  printLine(
    `oss-ai-agent-tool CLI
Usage:
  aidt new-agent <name>           Create agents/<name>/agent.md from template
  aidt plan <goal...>             Create a plan under .plans/
`
  );
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
  const dir = `${agentsRoot}${path.sep}${normalized}`;
  const relativeToAgents = path.relative(agentsRoot, dir);
  if (relativeToAgents.startsWith("..") || path.isAbsolute(relativeToAgents)) {
    throw new Error(`Refusing to write outside agents directory: ${normalized}`);
  }

  const file = path.normalize(`${dir}${path.sep}agent.md`);
  const relativeFile = path.relative(agentsRoot, file);
  if (relativeFile.startsWith("..") || path.isAbsolute(relativeFile)) {
    throw new Error(`Refusing to write outside agents directory: ${normalized}`);
  }

  const templatePath = path.resolve(repoRoot, "docs", "agents", "templates", "agent.md");
  if (!fs.existsSync(templatePath)) {
    logger.error("Template not found for agent creation", { templatePath });
    printErrorLine("Template not found:", templatePath);
    process.exit(1);
  }
  fs.mkdirSync(agentsRoot, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const tpl = fs
    .readFileSync(templatePath, "utf-8")
    .replace('name: "code-writer"', `name: "${normalized}"`);
  if (fs.existsSync(file)) {
    throw new Error(`agent.md already exists at ${file}`);
  }
  try {
    fs.writeFileSync(file, tpl, { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`agent.md already exists at ${file}`);
    }
    throw error;
  }
  printLine("Created", file);
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

main().catch(error => {
  const err = error instanceof Error ? error : new Error(String(error));
  logger.error(err);
  printErrorLine("Error:", err.message);
  process.exit(1);
});
