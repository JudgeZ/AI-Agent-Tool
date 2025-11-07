const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");

const execFileAsync = promisify(execFile);

const cliRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(cliRoot, "..", "..");
const agentsDir = path.join(repoRoot, "agents");

function cleanupAgent(name) {
  const targetDir = path.join(agentsDir, name);
  fs.rmSync(targetDir, { recursive: true, force: true });
  if (fs.existsSync(agentsDir) && fs.readdirSync(agentsDir).length === 0) {
    fs.rmdirSync(agentsDir);
  }
}

test("aidt new-agent scaffolds an agent profile", async () => {
  const agentName = "sample-agent";
  cleanupAgent(agentName);

  await execFileAsync("node", ["apps/cli/dist/index.js", "new-agent", agentName], { cwd: repoRoot });

  const agentPath = path.join(agentsDir, agentName, "agent.md");
  assert.ok(fs.existsSync(agentPath), `expected agent profile at ${agentPath}`);
  const contents = fs.readFileSync(agentPath, "utf8");
  assert.match(contents, new RegExp(`name: \"${agentName}\"`));

  cleanupAgent(agentName);
});

test("aidt new-agent rejects traversal attempts", async () => {
  const traversalName = "../traversal-agent";
  const escapeDir = path.resolve(repoRoot, "traversal-agent");
  fs.rmSync(escapeDir, { recursive: true, force: true });

  await assert.rejects(
    execFileAsync("node", ["apps/cli/dist/index.js", "new-agent", traversalName], { cwd: repoRoot }),
    err => {
      assert.strictEqual(err.code, 1);
      assert.match(err.stderr, /Agent name must not contain/);
      return true;
    }
  );

  assert.ok(!fs.existsSync(escapeDir), `expected no directory created at ${escapeDir}`);
  if (fs.existsSync(agentsDir)) {
    const agentEntries = fs.readdirSync(agentsDir);
    assert.ok(!agentEntries.includes("traversal-agent"), "unexpected traversal-agent directory under agents/");
  }
});

test("aidt new-agent rejects unsafe agent names", async () => {
  const badNames = ["/tmp/escape", "C:evil", "with space", "semi;colon", "star*bad", "-leading-dash"];

  for (const badName of badNames) {
    await assert.rejects(
      execFileAsync("node", ["apps/cli/dist/index.js", "new-agent", badName], { cwd: repoRoot }),
      err => {
        assert.strictEqual(err.code, 1);
        assert.ok(
          /Agent name/.test(err.stderr),
          `expected validation error message for ${badName}, got: ${err.stderr}`
        );
        return true;
      }
    );
  }
});

