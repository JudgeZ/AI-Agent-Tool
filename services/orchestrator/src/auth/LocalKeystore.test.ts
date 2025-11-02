import { randomBytes, scrypt as nodeScrypt } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import nacl from "tweetnacl";
import { afterEach, describe, expect, it } from "vitest";

import { LocalKeystore } from "./LocalKeystore.js";

const scrypt = promisify(nodeScrypt);

function encode(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

function decode(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, "base64"));
}

describe("LocalKeystore", () => {
  let tempDir: string;
  let filePath: string;

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("encrypts and decrypts secrets with the provided passphrase", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "keystore-"));
    filePath = path.join(tempDir, "secrets.json");
    const keystore = new LocalKeystore(filePath, "test-passphrase");

    await keystore.write({ token: "secret-value" });
    const result = await keystore.read();

    expect(result).toEqual({ token: "secret-value" });
    const stats = await fs.stat(filePath);
    if (process.platform !== "win32") {
      expect(stats.mode & 0o777).toBe(0o600);
    }
    // Scrypt is intentionally configured with the legacy work factors and can
    // exceed Vitest's 5s default timeout on slower CI executors.
  }, 15000);

  it("rejects decryption with an incorrect passphrase", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "keystore-"));
    filePath = path.join(tempDir, "secrets.json");
    const keystore = new LocalKeystore(filePath, "correct-passphrase");
    await keystore.write({ token: "value" });

    const wrongKeystore = new LocalKeystore(filePath, "wrong-passphrase");
    await expect(wrongKeystore.read()).rejects.toThrow("Failed to decrypt keystore");
  });

  it("reads legacy v1 payloads created with scrypt", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "keystore-"));
    filePath = path.join(tempDir, "secrets.json");

    const passphrase = "legacy-passphrase";
    const salt = randomBytes(16);
    const nonce = randomBytes(nacl.secretbox.nonceLength);
    const keyBuffer = (await scrypt(passphrase, salt, 32)) as Buffer;
    const key = new Uint8Array(keyBuffer);
    const plaintext = Buffer.from(JSON.stringify({ legacy: "present" }), "utf-8");
    const cipher = nacl.secretbox(new Uint8Array(plaintext), nonce, key);

    const payload = {
      version: 1,
      salt: encode(salt),
      nonce: encode(nonce),
      cipher: encode(cipher)
    } satisfies Record<string, unknown>;

    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });

    const keystore = new LocalKeystore(filePath, passphrase);
    const secrets = await keystore.read();

    expect(secrets).toEqual({ legacy: "present" });
  });
});

