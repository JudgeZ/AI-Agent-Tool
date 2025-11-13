const { spawnSync } = require("node:child_process");
const {
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");
const https = require("node:https");

function downloadToBuffer(url, logger, redirectCount = 0) {
  const maxRedirects = 5;
  return new Promise((resolve, reject) => {
    const request = https.get(url, (res) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        if (redirectCount >= maxRedirects) {
          reject(new Error("Too many HTTP redirects while downloading OPA."));
          res.resume();
          return;
        }
        const nextUrl = new URL(res.headers.location, url).toString();
        res.resume();
        downloadToBuffer(nextUrl, logger, redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`Unexpected HTTP status ${res.statusCode}`));
        res.resume();
        return;
      }

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });

    request.on("error", reject);
  });
}

async function ensureOpaBinary(options = {}) {
  const { logger, version = "0.63.0", cacheDir } = options;
  const log = logger ?? { info() {}, error() {}, warn() {} };

  const envBin = process.env.OPA_BIN?.trim();
  if (envBin) {
    const check = spawnSync(envBin, ["version"], { stdio: "ignore", shell: false });
    if (check.error) {
      log.error?.("OPA_BIN is set but could not be executed.", {
        error: check.error.message,
        path: envBin,
      });
      throw check.error;
    }
    if (check.status === 0) {
      return envBin;
    }
    const statusError = new Error("OPA_BIN is set but failed the version check");
    log.error?.("OPA_BIN is set but exited with a non-zero status during the version check.", {
      path: envBin,
      status: check.status,
    });
    throw statusError;
  }

  const systemCheck = spawnSync("opa", ["version"], { stdio: "ignore", shell: false });
  if (!systemCheck.error && systemCheck.status === 0) {
    return "opa";
  }

  const platform = process.platform;
  const arch = process.arch;

  function resolveDownload() {
    const base = `https://openpolicyagent.org/downloads/v${version}`;
    if (platform === "linux" && arch === "x64") {
      return { url: `${base}/opa_linux_amd64`, binName: "opa" };
    }
    if (platform === "darwin" && arch === "x64") {
      return { url: `${base}/opa_darwin_amd64`, binName: "opa" };
    }
    if (platform === "darwin" && arch === "arm64") {
      return { url: `${base}/opa_darwin_arm64`, binName: "opa" };
    }
    if (platform === "win32" && arch === "x64") {
      return { url: `${base}/opa_windows_amd64.exe`, binName: "opa.exe" };
    }
    return null;
  }

  const download = resolveDownload();
  if (!download) {
    const error = new Error("Automatic OPA download is not supported on this platform.");
    log.error?.(error.message, { platform, arch });
    throw error;
  }

  const targetDir = cacheDir ?? join(__dirname, ".cache", `opa-${version}-${platform}-${arch}`);
  mkdirSync(targetDir, { recursive: true });
  const binaryPath = join(targetDir, download.binName);

  if (!existsSync(binaryPath)) {
    log.info?.("Downloading OPA CLI.", {
      version,
      platform,
      arch,
      url: download.url,
    });
    const curlCheck = spawnSync("curl", ["--version"], { stdio: "ignore", shell: false });
    if (!curlCheck.error && curlCheck.status === 0) {
      const curlResult = spawnSync(
        "curl",
        ["-fL", "-sS", "-o", binaryPath, download.url],
        { stdio: "inherit", shell: false },
      );
      if (curlResult.error) {
        log.error?.("Unable to download the OPA binary.", { error: curlResult.error.message });
        throw curlResult.error;
      }
      if (curlResult.status !== 0) {
        const error = new Error(`curl exited with status ${curlResult.status}`);
        log.error?.("Unable to download the OPA binary.", { error: error.message });
        throw error;
      }
    } else {
      try {
        const buffer = await downloadToBuffer(download.url, log);
        writeFileSync(binaryPath, buffer);
      } catch (error) {
        log.error?.("Unable to download the OPA binary.", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    if (platform !== "win32") {
      chmodSync(binaryPath, 0o755);
    }
  }

  const verify = spawnSync(binaryPath, ["version"], { stdio: "ignore", shell: false });
  if (verify.error || verify.status !== 0) {
    const message = verify.error?.message ?? `status ${verify.status}`;
    log.error?.("Downloaded OPA binary failed during verification.", { error: message });
    throw verify.error ?? new Error(message);
  }

  return binaryPath;
}

module.exports = { ensureOpaBinary };
