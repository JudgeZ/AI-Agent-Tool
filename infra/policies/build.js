#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { mkdirSync, rmSync, readFileSync, writeFileSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { gunzipSync } = require("node:zlib");
const { ensureOpaBinary } = require("./opa");

const { createLogger } = require("../../scripts/logger");
const logger = createLogger({ name: "opa-build" });

const cwd = resolve(__dirname);
const distDir = join(cwd, "dist");
const bundlePath = join(distDir, "capabilities.tar.gz");
const regoPath = join(cwd, "capabilities.rego");

mkdirSync(distDir, { recursive: true });

try {
  rmSync(bundlePath, { force: true });
} catch (err) {
  if (err && err.code !== "ENOENT") {
    logger.warn("Unable to remove existing OPA bundle.", {
      error: err.message
    });
  }
}

(async () => {
  const opaBinary = await ensureOpaBinary({ logger });

  const args = [
    "build",
    "-t",
    "wasm",
    "-e",
    "orchestrator/capabilities/allow",
    "-o",
    bundlePath,
    regoPath,
  ];

  const result = spawnSync(opaBinary, args, {
    cwd,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    logger.error("Failed to launch the OPA CLI.", {
      error: result.error.message
    });
    process.exit(1);
  }

  if (result.status !== 0) {
    logger.error("OPA build exited with a non-zero status.", {
      status: result.status
    });
    process.exit(result.status ?? 1);
  }

  logger.info("OPA bundle written.", { bundlePath });

  const archive = readFileSync(bundlePath);
  const tarBuffer = gunzipSync(archive);

  function readString(buffer, start, end) {
    const raw = buffer.subarray(start, end);
    const nul = raw.indexOf(0);
    return raw.subarray(0, nul >= 0 ? nul : raw.length).toString("utf8").trim();
  }

  function extractFiles(buffer) {
    let offset = 0;
    const files = new Map();
    const blockSize = 512;

    while (offset + blockSize <= buffer.length) {
      const header = buffer.subarray(offset, offset + blockSize);
      const empty = header.every(byte => byte === 0);
      offset += blockSize;
      if (empty) {
        break;
      }
    const name = readString(header, 0, 100);
    const sizeOctal = readString(header, 124, 136);
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    const file = buffer.subarray(offset, offset + size);
    const normalized = name.replace(/^\/+/, "");
    files.set(normalized || name, Buffer.from(file));
      offset += size;
      const padding = (blockSize - (size % blockSize)) % blockSize;
      offset += padding;
    }

    return files;
  }

  const files = extractFiles(tarBuffer);
  const wasm = files.get("policy.wasm");
  if (!wasm) {
    logger.error("policy.wasm not found in the generated bundle.");
    process.exit(1);
  }
  writeFileSync(join(distDir, "capabilities.wasm"), wasm);

  const data = files.get("data.json");
  if (data) {
    writeFileSync(join(distDir, "data.json"), data);
  }

  logger.info("Extracted policy.wasm to capabilities.wasm.", {
    outputPath: join(distDir, "capabilities.wasm")
  });
})();

