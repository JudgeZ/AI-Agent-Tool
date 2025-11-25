const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");

const execFileAsync = promisify(execFile);

const cliRoot = path.resolve(__dirname, "..");
const tsNodeRegister = require.resolve("ts-node/register/transpile-only", { paths: [cliRoot] });
const CLI_ENTRY = path.join(cliRoot, "src", "index.ts");
const CLI_ARGS = ["-r", tsNodeRegister, CLI_ENTRY];

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

test("aidt chat routes message via gateway", async () => {
  /** @type {{ headers: http.IncomingHttpHeaders, body: any } | undefined} */
  let requestLog;
  const server = await startServer((req, res) => {
    if (req.method === "POST" && req.url === "/chat") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", chunk => {
        body += chunk;
      });
      req.on("end", () => {
        requestLog = { headers: req.headers, body: JSON.parse(body) };
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ response: { output: "pong", provider: "router" }, requestId: "req-1" }),
        );
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
    API_KEY: "integration-token",
  };

  try {
    const { stdout } = await execFileAsync("node", [...CLI_ARGS, "chat", "hello"], {
      cwd: cliRoot,
      env,
    });
    assert.match(stdout, /pong/);
    assert.ok(requestLog, "gateway should receive chat call");
    assert.equal(requestLog.headers.authorization, "Bearer integration-token");
    assert.deepEqual(requestLog.body.messages, [{ role: "user", content: "hello" }]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("aidt ops lists cases and workflows", async () => {
  /** @type {Array<string>} */
  const paths = [];
  const server = await startServer((req, res) => {
    paths.push(req.url || "");
    if (req.method === "GET" && req.url === "/cases") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ cases: [{ id: "case-1", title: "Demo", status: "open", projectId: "proj" }] }),
      );
      return;
    }
    if (req.method === "GET" && req.url === "/workflows") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ workflows: [{ id: "wf-1", status: "running" }] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  const env = {
    ...process.env,
    TS_NODE_PROJECT: path.join(cliRoot, "tsconfig.json"),
    AIDT_GATEWAY_URL: `http://127.0.0.1:${getPort(server)}`,
    API_KEY: "ops-token",
  };

  try {
    const { stdout } = await execFileAsync("node", [...CLI_ARGS, "ops"], {
      cwd: cliRoot,
      env,
    });
    assert.match(stdout, /Demo/);
    assert.match(stdout, /workflow wf-1/);
    assert.deepEqual(paths.filter(Boolean).sort(), ["/cases", "/workflows"]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("aidt ops reports empty lists and mode filtering", async () => {
  const paths = [];
  const server = await startServer((req, res) => {
    paths.push(req.url || "");
    if (req.method === "GET" && req.url === "/cases") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ cases: [] }));
      return;
    }
    if (req.method === "GET" && req.url === "/workflows") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ workflows: [] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  const env = {
    ...process.env,
    TS_NODE_PROJECT: path.join(cliRoot, "tsconfig.json"),
    AIDT_GATEWAY_URL: `http://127.0.0.1:${getPort(server)}`,
    API_KEY: "ops-token",
  };

  try {
    const { stdout: allStdout } = await execFileAsync("node", [...CLI_ARGS, "ops"], {
      cwd: cliRoot,
      env,
    });
    assert.match(allStdout, /No cases found/);
    assert.match(allStdout, /No workflows found/);

    const { stdout: casesStdout } = await execFileAsync("node", [...CLI_ARGS, "ops", "cases"], {
      cwd: cliRoot,
      env,
    });
    assert.match(casesStdout, /No cases found/);

    const { stdout: workflowsStdout } = await execFileAsync("node", [...CLI_ARGS, "ops", "workflows"], {
      cwd: cliRoot,
      env,
    });
    assert.match(workflowsStdout, /No workflows found/);

    const filteredPaths = paths.filter(Boolean).sort();
    assert.deepEqual(filteredPaths, ["/cases", "/cases", "/workflows", "/workflows"]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
