#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

let createLogger;

try {
  ({ createLogger } = require("../../../scripts/logger"));
} catch (error) {
  const isMissing =
    error?.code === "MODULE_NOT_FOUND" &&
    typeof error?.message === "string" &&
    error.message.includes("../../../scripts/logger");

  if (!isMissing) {
    throw error;
  }

  createLogger = function fallbackCreateLogger(options = {}) {
    const { name = "" } = options;

    const emit = (level, message, context) => {
      const payload = {
        level,
        msg: message,
        time: new Date().toISOString()
      };

      if (name) {
        payload.name = name;
      }

      if (context !== undefined) {
        payload.context = context;
      }

      const writer = console[level] || console.log;
      writer(JSON.stringify(payload));
    };

    return {
      debug(message, context) {
        emit("debug", message, context);
      },
      info(message, context) {
        emit("info", message, context);
      },
      warn(message, context) {
        emit("warn", message, context);
      },
      error(message, context) {
        emit("error", message, context);
      }
    };
  };
}

const pkgName = "@mistralai/mistralai";
const moduleRoot = path.join(__dirname, "..", "node_modules", "@mistralai", "mistralai");
const logger = createLogger({ name: "prune-mistral-extras" });

const targets = [
  "examples",
  path.join("packages", "mistralai-azure"),
  path.join("packages", "mistralai-gcp"),
  "tests"
];

const strayLocks = [
  path.join("package-lock.json"),
  path.join("examples", "package-lock.json"),
  path.join("tests", "package-lock.json")
];

const formatError = (error) => (error && error.stack) || (error && error.message) || String(error);

const main = () => {
  if (!fs.existsSync(moduleRoot)) {
    return [];
  }

  const removed = [];

  for (const target of targets) {
    const fullPath = path.join(moduleRoot, target);
    if (!fs.existsSync(fullPath)) {
      continue;
    }

    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
      removed.push(target);
    } catch (error) {
      logger.warn("Failed to prune mistral extras target.", {
        package: pkgName,
        target,
        error: formatError(error)
      });
    }
  }

  for (const lockRelPath of strayLocks) {
    const lockPath = path.join(moduleRoot, lockRelPath);
    if (!fs.existsSync(lockPath)) {
      continue;
    }

    try {
      fs.rmSync(lockPath, { force: true });
      removed.push(path.normalize(lockRelPath));
    } catch (error) {
      logger.warn("Failed to remove mistral lockfile.", {
        package: pkgName,
        lockFile: lockRelPath,
        error: formatError(error)
      });
    }
  }

  return removed;
};

try {
  const removed = main();
  if (removed.length > 0) {
    logger.info("Pruned mistral extras.", {
      package: pkgName,
      removed
    });
  }
} catch (error) {
  logger.warn("Failed to prune mistral extras.", {
    package: pkgName,
    error: formatError(error)
  });
}
