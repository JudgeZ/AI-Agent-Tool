require("ts-node/register/transpile-only");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("module");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");

const execFileAsync = promisify(execFile);
const cliRoot = path.resolve(__dirname, "..");

async function withStubbedModule(modulePath, exports, fn) {
  const resolvedPath = require.resolve(modulePath);
  const original = require.cache[resolvedPath];
  const stub = new Module(modulePath);
  stub.filename = resolvedPath;
  stub.exports = exports;
  require.cache[resolvedPath] = stub;

  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return await result;
    }
    return result;
  } finally {
    if (original) {
      require.cache[resolvedPath] = original;
    } else {
      delete require.cache[resolvedPath];
    }
  }
}

function clearModules(...modulePaths) {
  for (const modulePath of modulePaths) {
    delete require.cache[require.resolve(modulePath)];
  }
}

async function initRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-commit-"));
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "aidt@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "AIDT"], { cwd: repoDir });
  return repoDir;
}

test("runCode validates input and forwards goal", async () => {
  const planModulePath = path.join(cliRoot, "src/commands/plan");
  const runPlanCalls = [];
  await withStubbedModule(planModulePath, { runPlan: async goal => runPlanCalls.push(goal) }, async () => {
    clearModules("../src/commands/code");
    const { runCode } = require("../src/commands/code");
    await assert.rejects(() => runCode("   "), /requires a goal/);
    await runCode("Ship the release");
  });
  assert.deepEqual(runPlanCalls, ["Ship the release"]);
});

test("runCommit rejects clean indexes and unstaged changes", async () => {
  const originalCwd = process.cwd();
  const repoDir = await initRepo();
  const commitModulePath = path.join(cliRoot, "src/commands/commit");
  const chatModulePath = path.join(cliRoot, "src/commands/chat");
  const outputModulePath = path.join(cliRoot, "src/output");

  // provide a stub requestCommitMessage to avoid network lookups
  await withStubbedModule(chatModulePath, { requestCommitMessage: async () => "unused" }, () => {
    return withStubbedModule(outputModulePath, { printLine: () => {} }, async () => {
      clearModules(commitModulePath);
      const { runCommit } = require(commitModulePath);
      process.chdir(repoDir);
      try {
        await assert.rejects(() => runCommit(), /Working directory is clean/);
        fs.writeFileSync(path.join(repoDir, "file.txt"), "hello");
        await assert.rejects(() => runCommit(), /No staged changes found/);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });
  fs.rmSync(repoDir, { recursive: true, force: true });
});

test("runCommit commits staged changes with gateway-provided message", async () => {
  const originalCwd = process.cwd();
  const repoDir = await initRepo();
  fs.writeFileSync(path.join(repoDir, "commit.txt"), "commit me\n");
  await execFileAsync("git", ["add", "commit.txt"], { cwd: repoDir });

  const commitModulePath = path.join(cliRoot, "src/commands/commit");
  const chatModulePath = path.join(cliRoot, "src/commands/chat");
  const outputModulePath = path.join(cliRoot, "src/output");

  const printed = [];
  let providedDiff;
  let providedGoal;

  await withStubbedModule(chatModulePath, {
    requestCommitMessage: async (diff, goal) => {
      providedDiff = diff;
      providedGoal = goal;
      return "chore: add commit test";
    },
  }, () => {
    return withStubbedModule(
      outputModulePath,
      { printLine: (...parts) => printed.push(parts.join(" ")) },
      async () => {
        clearModules(commitModulePath);
        const { runCommit } = require(commitModulePath);
        process.chdir(repoDir);
        try {
          await runCommit("validate commit flow");
        } finally {
          process.chdir(originalCwd);
        }
      },
    );
  });

  const { stdout } = await execFileAsync("git", ["log", "-1", "--pretty=%B"], { cwd: repoDir });
  assert.equal(stdout.trim(), "chore: add commit test");
  assert.ok(providedDiff.includes("commit me"));
  assert.equal(providedGoal, "validate commit flow");
  assert.ok(printed.some(line => line.includes("Committed with message:")));
  fs.rmSync(repoDir, { recursive: true, force: true });
});

test("runChat prints provider, usage, and warnings", async () => {
  const gatewayModulePath = path.join(cliRoot, "src/gateway");
  const outputModulePath = path.join(cliRoot, "src/output");
  const outputs = [];
  const postCalls = [];

  await withStubbedModule(gatewayModulePath, {
    resolveGatewayConfig: () => ({ baseUrl: "http://gateway", timeoutMs: 5000 }),
    postJson: async (pathname, body) => {
      postCalls.push({ pathname, body });
      return {
        response: {
          output: "ok",
          provider: "router",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          warnings: ["slow path", "cached response"],
        },
      };
    },
  }, () => {
    return withStubbedModule(outputModulePath, { printLine: (...parts) => outputs.push(parts.join(" ")) }, async () => {
      clearModules("../src/commands/chat");
      const { runChat } = require("../src/commands/chat");
      await assert.rejects(() => runChat("   "), /Chat message is required/);
      outputs.length = 0;
      await runChat("Hello", { model: "gpt", provider: "demo", temperature: 0.4 });
    });
  });

  assert.equal(postCalls[0].pathname, "chat");
  assert.deepEqual(postCalls[0].body.messages, [{ role: "user", content: "Hello" }]);
  assert.equal(postCalls[0].body.model, "gpt");
  assert.equal(postCalls[0].body.provider, "demo");
  assert.equal(outputs[0], "ok");
  assert.ok(outputs.find(line => line.includes("Provider: router")));
  assert.ok(outputs.find(line => line.includes("Usage: prompt=10, completion=5, total=15")));
  assert.ok(outputs.find(line => line.includes("Warning: slow path")));
  assert.ok(outputs.find(line => line.includes("Warning: cached response")));
});

test("requestCommitMessage trims gateway response and uses low-cost routing", async () => {
  const gatewayModulePath = path.join(cliRoot, "src/gateway");
  const postCalls = [];

  await withStubbedModule(gatewayModulePath, {
    resolveGatewayConfig: () => ({ baseUrl: "http://gateway", timeoutMs: 1000 }),
    postJson: async (pathname, body) => {
      postCalls.push({ pathname, body });
      return { response: { output: "fix: handle edge case\nextra detail" } };
    },
  }, async () => {
    clearModules("../src/commands/chat");
    const { requestCommitMessage } = require("../src/commands/chat");
    const message = await requestCommitMessage("diff content", "ensure coverage");
    assert.equal(message, "fix: handle edge case");
  });

  assert.equal(postCalls[0].pathname, "chat");
  assert.equal(postCalls[0].body.routing, "low_cost");
  assert.match(postCalls[0].body.messages[0].content, /Goal: ensure coverage/);
});
