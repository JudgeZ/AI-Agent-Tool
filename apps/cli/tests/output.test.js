require("ts-node/register/transpile-only");

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { printLine, printErrorLine } = require("../src/output");

test("printLine writes formatted content to stdout", () => {
  /** @type {string[]} */
  const writes = [];
  const originalWrite = process.stdout.write;
  // @ts-ignore - mutate for testing purposes
  process.stdout.write = chunk => {
    writes.push(String(chunk));
    return true;
  };
  try {
    printLine("Created", "file.md");
    printLine({ status: "ok" });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(writes[0], "Created file.md\n");
  assert.equal(writes[1], '{"status":"ok"}\n');
});

test("printErrorLine writes formatted content to stderr", () => {
  /** @type {string[]} */
  const writes = [];
  const originalWrite = process.stderr.write;
  // @ts-ignore - mutate for testing purposes
  process.stderr.write = chunk => {
    writes.push(String(chunk));
    return true;
  };
  try {
    printErrorLine("Error:", new Error("boom"));
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(writes[0], "Error: boom\n");
});
