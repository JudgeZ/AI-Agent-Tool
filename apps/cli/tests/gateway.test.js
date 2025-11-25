require("ts-node/register/transpile-only");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveGatewayConfig,
  joinUrl,
  readErrorMessage,
  GatewayHttpError,
  postJson,
  getJson,
} = require("../src/gateway");

function withEnv(env, fn) {
  const previous = { ...process.env };
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    process.env = previous;
  }
}

function withFetch(mock, fn) {
  const original = global.fetch;
  global.fetch = mock;
  return fn().finally(() => {
    global.fetch = original;
  });
}

test("resolveGatewayConfig enforces valid URLs and timeouts", () => {
  withEnv({ AIDT_GATEWAY_URL: "nota-url" }, () => {
    assert.throws(() => resolveGatewayConfig({ requireApiKey: false }), /Invalid gateway URL/);
  });

  withEnv({ AIDT_GATEWAY_URL: "ftp://example.com" }, () => {
    assert.throws(() => resolveGatewayConfig({ requireApiKey: false }), /must use http or https/);
  });

  withEnv({ AIDT_GATEWAY_URL: "http://user:pass@example.com" }, () => {
    assert.throws(() => resolveGatewayConfig({ requireApiKey: false }), /Credentials in URLs are not supported/);
  });

  withEnv({
    AIDT_GATEWAY_URL: "http://gateway", 
    AIDT_GATEWAY_TIMEOUT_MS: "-5",
  }, () => {
    assert.throws(() => resolveGatewayConfig({ requireApiKey: false }), /Invalid gateway timeout/);
  });

  withEnv({
    AIDT_GATEWAY_URL: "https://gateway", 
    AIDT_GATEWAY_TIMEOUT_MS: "2500",
    API_KEY: "token-123",
  }, () => {
    const cfg = resolveGatewayConfig();
    assert.equal(cfg.baseUrl, "https://gateway");
    assert.equal(cfg.timeoutMs, 2500);
    assert.equal(cfg.apiKey, "token-123");
  });
});

test("joinUrl normalizes slashes", () => {
  assert.equal(joinUrl("http://gateway", "/chat"), "http://gateway/chat");
  assert.equal(joinUrl("http://gateway/", "cases"), "http://gateway/cases");
});

test("joinUrl rejects absolute URLs to prevent credential leaks", () => {
  assert.throws(() => joinUrl("http://gateway", "https://example.com"), /must be relative/);
  assert.throws(() => joinUrl("http://gateway", "//example.com"), /must be relative/);
  assert.throws(() => joinUrl("http://gateway", ""), /path is required/);
});

test("readErrorMessage parses JSON and arrays", async () => {
  const message = await readErrorMessage(
    new Response(JSON.stringify({ error: { message: "bad input" } }), {
      status: 400,
      headers: new Headers({ "content-type": "application/json" }),
    }),
  );
  assert.equal(message, "bad input");

  const fallback = await readErrorMessage(
    new Response(JSON.stringify({ errors: ["rate limit", "retry"] }), {
      status: 429,
      headers: new Headers({ "content-type": "application/json" }),
    }),
  );
  assert.equal(fallback, "rate limit, retry");
});

test("postJson handles gateway error statuses", async () => {
  const cfg = { baseUrl: "http://gateway", timeoutMs: 1000, apiKey: "k" };
  await assert.rejects(
    () =>
      withFetch(
        async () => new Response(JSON.stringify({ message: "nope" }), { status: 401, headers: { "content-type": "application/json" } }),
        () => postJson("chat", { hello: "world" }, cfg),
      ),
    error => error instanceof GatewayHttpError && error.status === 401 && /Authentication failed/.test(error.message),
  );

  await assert.rejects(
    () =>
      withFetch(
        async () => new Response("boom", { status: 500, statusText: "Server Error", headers: { "x-request-id": "req-2" } }),
        () => postJson("chat", { hello: "world" }, cfg),
      ),
    error =>
      error instanceof GatewayHttpError &&
      /Server Error/.test(error.message) &&
      /req-2/.test(error.message) &&
      /req-2/.test(error.requestId || ""),
  );
});

test("postJson and getJson support timeouts and headers", async () => {
  const cfg = { baseUrl: "http://gateway", timeoutMs: 5, apiKey: "token" };

  await assert.rejects(
    () =>
      withFetch(async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }, () => postJson("chat", {}, cfg)),
    /timed out after 5ms/,
  );

  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, async () => {
    const postResult = await postJson("chat", { a: 1 }, cfg);
    assert.equal(postResult.ok, true);
    const getResult = await getJson("cases", cfg);
    assert.equal(getResult.ok, true);
  });

  assert.equal(calls[0].init.headers.authorization, "Bearer token");
  assert.equal(calls[0].init.redirect, "manual");
});

test("requestJson blocks redirects to avoid leaking credentials", async () => {
  const cfg = { baseUrl: "http://gateway", timeoutMs: 1000, apiKey: "token" };

  await assert.rejects(
    () =>
      withFetch(
        async () =>
          new Response("", {
            status: 302,
            statusText: "Found",
            headers: { location: "http://example.com" },
          }),
        () => postJson("chat", {}, cfg),
      ),
    (error) =>
      error instanceof GatewayHttpError &&
      error.status === 302 &&
      error.message.includes("redirect") &&
      error.message.includes("blocked"),
  );
});
