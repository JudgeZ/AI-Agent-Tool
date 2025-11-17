#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");

const { createLogger } = require("../../scripts/logger");
const { ensureOpaBinary } = require("./opa");

const logger = createLogger({ name: "opa-test" });

(async () => {
  const opaBinary = await ensureOpaBinary({ logger });
  const policyDir = resolve(__dirname);
  const dataDir = resolve(policyDir, "data");
  const args = ["test", policyDir];
  if (existsSync(dataDir)) {
    args.push(dataDir);
  }
  const result = spawnSync(opaBinary, args, { stdio: "inherit", shell: false });

  if (result.error) {
    logger.error("Failed to launch the OPA CLI.", {
      error: result.error.message,
    });
    process.exit(1);
  }

  if (result.status !== 0) {
    logger.error("OPA test exited with a non-zero status.", {
      status: result.status,
    });
    process.exit(result.status ?? 1);
  }

  logger.info("OPA tests completed successfully.");
})();
