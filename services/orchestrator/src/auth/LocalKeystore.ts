import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";
import sodium from "libsodium-wrappers-sumo";
import nacl from "tweetnacl";

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1 } as const;

const scrypt = promisify(scryptCb);

type PersistedPayload = {
  version: number;
  salt: string;
  nonce: string;
  cipher: string;
};

type SodiumModule = typeof sodium;

let sodiumModule: SodiumModule | null = null;

async function getSodium(): Promise<SodiumModule> {
  if (!sodiumModule) {
    await sodium.ready;
    sodiumModule = sodium;
  }
  return sodiumModule;
}

function encode(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

function decode(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, "base64"));
}

export class LocalKeystore {
  private salt?: Uint8Array;

  constructor(
    private readonly filePath: string,
    private readonly passphrase: string
  ) {
    if (!passphrase) {
      throw new Error("Local keystore requires a non-empty passphrase");
    }
  }

  async read(): Promise<Record<string, string>> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as PersistedPayload;
      if (parsed.version === 2) {
        return await this.decryptV2Payload(parsed);
      }
      if (parsed.version === 1) {
        return await this.decryptV1Payload(parsed);
      }
      if (!parsed.version) {
        try {
          return await this.decryptV2Payload({ ...parsed, version: 2 });
        } catch (error) {
          return await this.decryptV1Payload(parsed);
        }
      }
      throw new Error("Unsupported keystore payload format");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.salt = undefined;
        return {};
      }
      throw error;
    }
  }

  async write(values: Record<string, string>): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const salt = this.salt ?? randomBytes(SALT_LENGTH);
    this.salt = salt;
    
    try {
      const sodium = await getSodium();
      const key = sodium.crypto_pwhash(
        KEY_LENGTH,
        this.passphrase,
        salt,
        sodium.crypto_pwhash_OPSLIMIT_MODERATE,
        sodium.crypto_pwhash_MEMLIMIT_MODERATE,
        sodium.crypto_pwhash_ALG_ARGON2ID13
      );
      const nonce = randomBytes(nacl.secretbox.nonceLength);
      const plaintext = Buffer.from(JSON.stringify(values), "utf-8");
      const cipher = nacl.secretbox(new Uint8Array(plaintext), nonce, key);
      const payload: PersistedPayload = {
        version: 2,
        salt: encode(salt),
        nonce: encode(nonce),
        cipher: encode(cipher)
      };
      await fs.writeFile(this.filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    } catch (error) {
      throw new Error(`Failed to encrypt keystore: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async decryptV2Payload(payload: PersistedPayload): Promise<Record<string, string>> {
    const salt = decode(payload.salt);
    this.salt = salt;
    const sodium = await getSodium();
    const key = sodium.crypto_pwhash(
      KEY_LENGTH,
      this.passphrase,
      salt,
      sodium.crypto_pwhash_OPSLIMIT_MODERATE,
      sodium.crypto_pwhash_MEMLIMIT_MODERATE,
      sodium.crypto_pwhash_ALG_ARGON2ID13
    );
    const nonce = decode(payload.nonce);
    const cipher = decode(payload.cipher);
    const plaintext = nacl.secretbox.open(cipher, nonce, key);
    if (!plaintext) {
      throw new Error("Failed to decrypt keystore");
    }
    const json = Buffer.from(plaintext).toString("utf-8");
    return JSON.parse(json) as Record<string, string>;
  }

  private async decryptV1Payload(payload: PersistedPayload): Promise<Record<string, string>> {
    const salt = decode(payload.salt);
    this.salt = salt;
    const keyBuffer = await scrypt(
      this.passphrase,
      Buffer.from(salt),
      KEY_LENGTH,
      SCRYPT_PARAMS
    );
    const key = new Uint8Array(keyBuffer as Buffer);
    const nonce = decode(payload.nonce);
    const cipher = decode(payload.cipher);
    const plaintext = nacl.secretbox.open(cipher, nonce, key);
    if (!plaintext) {
      throw new Error("Failed to decrypt keystore");
    }
    const json = Buffer.from(plaintext).toString("utf-8");
    return JSON.parse(json) as Record<string, string>;
  }
}
