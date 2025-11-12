require("ts-node/register/transpile-only");

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createLogger, logger } = require("../src/logger");

test("createLogger respects provided level", () => {
  const custom = createLogger({ level: "debug" });
  assert.equal(custom.level, "debug");
});

test("child logger merges bindings", () => {
  const root = createLogger({ bindings: { subsystem: "cli" } });
  const child = root.child({ command: "plan" });
  assert.equal(child.level, root.level);
  assert.deepEqual(child.bindings(), { service: "cli", subsystem: "cli", command: "plan" });
});

test("shared logger exposes bindings", () => {
  assert.equal(typeof logger.info, "function");
  assert.equal(typeof logger.warn, "function");
  assert.equal(typeof logger.error, "function");
});
