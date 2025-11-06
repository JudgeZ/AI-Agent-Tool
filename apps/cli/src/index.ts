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

async function newAgent(name: string) {
  const dir = path.join(process.cwd(), "agents", name);
  const file = path.join(dir, "agent.md");
  const templatePath = path.join(process.cwd(), "docs", "agents", "templates", "agent.md");
  if (!fs.existsSync(templatePath)) {
    console.error("Template not found:", templatePath);
    process.exit(1);
  }
  fs.mkdirSync(dir, { recursive: true });
  const tpl = fs.readFileSync(templatePath, "utf-8").replace('name: "code-writer"', `name: "${name}"`);
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
