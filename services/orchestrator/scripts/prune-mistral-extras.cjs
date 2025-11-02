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

const removed = [];

if (!fs.existsSync(moduleRoot)) {
  process.exit(0);
}

for (const target of targets) {
  const fullPath = path.join(moduleRoot, target);
  if (fs.existsSync(fullPath)) {
    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
      removed.push(target);
    } catch (error) {
      console.warn("Failed to prune %s/%s:", pkgName, target, error);
    }
  }
}

const strayLocks = [
  path.join(moduleRoot, "package-lock.json"),
  path.join(moduleRoot, "examples", "package-lock.json"),
  path.join(moduleRoot, "tests", "package-lock.json")
];

for (const lockPath of strayLocks) {
  if (fs.existsSync(lockPath)) {
    try {
      fs.rmSync(lockPath, { force: true });
      removed.push(path.relative(moduleRoot, lockPath) || "package-lock.json");
    } catch (error) {
      console.warn("Failed to remove %s lock file %s:", pkgName, lockPath, error);
    }
  }
}

if (removed.length > 0) {
  console.log(`Pruned ${pkgName} extras: ${removed.join(", ")}`);
}
