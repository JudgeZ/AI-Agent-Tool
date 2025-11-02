#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const pkgName = "@mistralai/mistralai";
const moduleRoot = path.join(__dirname, "..", "node_modules", "@mistralai", "mistralai");

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
      console.warn("Failed to prune %s/%s: %s", pkgName, target, formatError(error));
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
      console.warn("Failed to remove %s lock file %s: %s", pkgName, lockRelPath, formatError(error));
    }
  }

  return removed;
};

try {
  const removed = main();
  if (removed.length > 0) {
    console.log("Pruned %s extras: %s", pkgName, removed.join(", "));
  }
} catch (error) {
  console.warn("Failed to prune %s extras: %s", pkgName, formatError(error));
}
