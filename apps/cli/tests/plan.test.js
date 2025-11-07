const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");

const execFileAsync = promisify(execFile);

const cliRoot = path.resolve(__dirname, "..");
const plansDir = path.join(cliRoot, ".plans");

function resetPlansDir() {
  fs.rmSync(plansDir, { recursive: true, force: true });
}

test("aidt plan requests plan from gateway", async () => {
  resetPlansDir();
  const goal = "Verify gateway invocation";
  const planResponse = {
    id: "plan-test123",
    goal,
    steps: [
      {
        id: "s1",
        action: "index_repo",
        tool: "repo_indexer",
        capability: "repo.read",
        capabilityLabel: "Read repository",
        timeoutSeconds: 120,
        approvalRequired: false,
        labels: ["repo"]
      }
    ],
    successCriteria: ["Artifacts created"]
  };
  /** @type {{ headers: http.IncomingHttpHeaders, body: any } | undefined} */
  let requestLog;

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/plan") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", chunk => {
        body += chunk;
      });
      req.on("end", () => {
        requestLog = {
          headers: req.headers,
          body: JSON.parse(body)
        };
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(planResponse));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  assert.ok(port, "server should provide a port");

  const env = {
    ...process.env,
    AIDT_GATEWAY_URL: `http://127.0.0.1:${port}`,
    AIDT_AUTH_TOKEN: "test-token"
  };

  try {
    const { stdout } = await execFileAsync("node", ["dist/index.js", "plan", goal], {
      cwd: cliRoot,
      env
    });

    assert.match(stdout, /Plan created: plan-test123/);
    assert.ok(requestLog, "gateway should receive a request");
    assert.equal(requestLog.body.goal, goal);
    assert.equal(requestLog.headers.authorization, "Bearer test-token");

    const planJsonPath = path.join(plansDir, planResponse.id, "plan.json");
    assert.ok(fs.existsSync(planJsonPath), `expected plan.json at ${planJsonPath}`);
    const plan = JSON.parse(fs.readFileSync(planJsonPath, "utf8"));
    assert.equal(plan.goal, planResponse.goal);
    assert.deepEqual(plan.steps, planResponse.steps);

    const planMdPath = path.join(plansDir, planResponse.id, "plan.md");
    assert.ok(fs.existsSync(planMdPath), `expected plan.md at ${planMdPath}`);
    assert.match(stdout, /SSE stream: \/plan\/plan-test123\/events/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
