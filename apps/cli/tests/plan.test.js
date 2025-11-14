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
const tsNodeRegister = require.resolve("ts-node/register/transpile-only", { paths: [cliRoot] });
const CLI_ENTRY = path.join(cliRoot, "src/index.ts");
const CLI_ARGS = ["-r", tsNodeRegister, CLI_ENTRY];

function resetPlansDir() {
  fs.rmSync(plansDir, { recursive: true, force: true });
}

async function startServer(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

function getPort(server) {
  const address = server.address();
  assert.ok(address && typeof address === "object", "server should provide a port");
  return address.port;
}

test("aidt plan requests plan from gateway", async () => {
  resetPlansDir();
  const goal = "Verify gateway invocation";
  const planResponse = {
    id: "plan-550e8400-e29b-41d4-a716-446655440000",
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

  const server = await startServer((req, res) => {
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

  const env = {
    ...process.env,
    TS_NODE_PROJECT: path.join(cliRoot, "tsconfig.json"),
    AIDT_GATEWAY_URL: `http://127.0.0.1:${getPort(server)}`,
    AIDT_AUTH_TOKEN: "test-token",
    AIDT_GATEWAY_TIMEOUT_MS: "1500"
  };

  try {
    const { stdout } = await execFileAsync("node", [...CLI_ARGS, "plan", goal], {
      cwd: cliRoot,
      env
    });

    assert.match(stdout, /Plan created: plan-550e8400-e29b-41d4-a716-446655440000/);
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
    assert.match(stdout, /SSE stream: \/plan\/plan-550e8400-e29b-41d4-a716-446655440000\/events/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("aidt plan surfaces gateway authentication failures", async () => {
  resetPlansDir();
  const goal = "Surface auth failure";
  let requestCount = 0;

  const server = await startServer((req, res) => {
    if (req.method === "POST" && req.url === "/plan") {
      requestCount += 1;
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.setHeader("x-request-id", "req-123");
      res.end(JSON.stringify({ message: "token invalid" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  const env = {
    ...process.env,
    TS_NODE_PROJECT: path.join(cliRoot, "tsconfig.json"),
    AIDT_GATEWAY_URL: `http://127.0.0.1:${getPort(server)}`,
    AIDT_AUTH_TOKEN: "bad-token"
  };

  try {
    await assert.rejects(
      execFileAsync("node", [...CLI_ARGS, "plan", goal], {
        cwd: cliRoot,
        env
      }),
      error => {
        assert.match(String(error), /Command failed/);
        assert.match(error.stderr, /Authentication failed: token invalid/);
        assert.match(error.stderr, /Error:/);
        return true;
      }
    );
    assert.equal(requestCount, 1, "gateway should handle exactly one request");
    assert.ok(!fs.existsSync(plansDir), "should not persist plan artifacts on failure");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("aidt plan rejects invalid plan id from gateway", async () => {
  resetPlansDir();
  const goal = "Handle invalid plan id";
  const planResponse = {
    id: "../bad",
    goal,
    steps: [],
    successCriteria: []
  };

  const server = await startServer((req, res) => {
    if (req.method === "POST" && req.url === "/plan") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(planResponse));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  const env = {
    ...process.env,
    TS_NODE_PROJECT: path.join(cliRoot, "tsconfig.json"),
    AIDT_GATEWAY_URL: `http://127.0.0.1:${getPort(server)}`
  };

  try {
    await assert.rejects(
      execFileAsync("node", [...CLI_ARGS, "plan", goal], {
        cwd: cliRoot,
        env
      }),
      error => {
        assert.match(String(error), /invalid plan id/i);
        return true;
      }
    );
    assert.ok(!fs.existsSync(plansDir), "should not create artifacts for invalid ids");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("aidt plan enforces secure gateway url schemes", async () => {
  resetPlansDir();
  const env = {
    ...process.env,
    TS_NODE_PROJECT: path.join(cliRoot, "tsconfig.json"),
    AIDT_GATEWAY_URL: "ftp://127.0.0.1:8080"
  };

  await assert.rejects(
    execFileAsync("node", [...CLI_ARGS, "plan", "goal"], {
      cwd: cliRoot,
      env
    }),
    error => {
      assert.match(String(error), /Invalid gateway URL: ftp:\/\/127\.0\.0\.1:8080/);
      assert.match(String(error), /Gateway URL must use http or https\./);
      return true;
    }
  );
});

test("aidt plan rejects invalid gateway URL configuration", async () => {
  resetPlansDir();
  const goal = "Invalid gateway URL";
  const env = {
    ...process.env,
    TS_NODE_PROJECT: path.join(cliRoot, "tsconfig.json"),
    AIDT_GATEWAY_URL: "not-a-valid-url"
  };

  await assert.rejects(
    execFileAsync("node", [...CLI_ARGS, "plan", goal], {
      cwd: cliRoot,
      env
    }),
    error => {
      assert.match(error.stderr, /Invalid gateway URL/);
      assert.match(error.stderr, /Error:/);
      assert.ok(!fs.existsSync(plansDir), "should not create .plans for invalid configuration");
      return true;
    }
  );
});

test("aidt plan reports gateway rate limiting detail", async () => {
  resetPlansDir();
  const goal = "Handle rate limiting";
  let requestCount = 0;

  const server = await startServer((req, res) => {
    if (req.method === "POST" && req.url === "/plan") {
      requestCount += 1;
      res.statusCode = 429;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Too many requests" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  const env = {
    ...process.env,
    TS_NODE_PROJECT: path.join(cliRoot, "tsconfig.json"),
    AIDT_GATEWAY_URL: `http://127.0.0.1:${getPort(server)}`,
    AIDT_AUTH_TOKEN: "rate-limit-token"
  };

  try {
    await assert.rejects(
      execFileAsync("node", [...CLI_ARGS, "plan", goal], {
        cwd: cliRoot,
        env
      }),
      error => {
        assert.match(error.stderr, /Gateway rate limited the request: Too many requests/);
        return true;
      }
    );
    assert.equal(requestCount, 1);
    assert.ok(!fs.existsSync(plansDir), "should not create artifacts when rate limited");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("aidt plan surfaces server errors with request id context", async () => {
  resetPlansDir();
  const goal = "Handle server error";

  const server = await startServer((req, res) => {
    if (req.method === "POST" && req.url === "/plan") {
      res.statusCode = 503;
      res.statusMessage = "Service Unavailable";
      res.setHeader("x-request-id", "req-789");
      res.end("backend offline");
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  const env = {
    ...process.env,
    TS_NODE_PROJECT: path.join(cliRoot, "tsconfig.json"),
    AIDT_GATEWAY_URL: `http://127.0.0.1:${getPort(server)}`
  };

  try {
    await assert.rejects(
      execFileAsync("node", [...CLI_ARGS, "plan", goal], {
        cwd: cliRoot,
        env
      }),
      error => {
        assert.match(
          error.stderr,
          /Gateway request failed \(request id req-789\) - Service Unavailable: backend offline/
        );
        return true;
      }
    );
    assert.ok(!fs.existsSync(plansDir), "should not persist plan artifacts for server errors");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("aidt plan rejects invalid gateway timeout configuration", async () => {
  resetPlansDir();
  const goal = "Invalid timeout";
  const env = {
    ...process.env,
    TS_NODE_PROJECT: path.join(cliRoot, "tsconfig.json"),
    AIDT_GATEWAY_URL: "http://127.0.0.1:65534",
    AIDT_GATEWAY_TIMEOUT_MS: "not-a-number"
  };

  await assert.rejects(
    execFileAsync("node", [...CLI_ARGS, "plan", goal], {
      cwd: cliRoot,
      env
    }),
    error => {
      assert.match(error.stderr, /Invalid gateway timeout/);
      return true;
    }
  );
  assert.ok(!fs.existsSync(plansDir), "should not create plan artifacts when timeout config is invalid");
});
