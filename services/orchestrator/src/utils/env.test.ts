import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileSyncMock = vi.fn<(path: string, encoding: BufferEncoding) => string>();

vi.mock("node:fs", () => ({
  readFileSync: readFileSyncMock
}));

let resolveEnv: (name: string, fallback?: string) => string | undefined;
let requireEnv: (name: string) => string;

const originalEnv = process.env;

describe("env utilities", () => {
  beforeEach(async () => {
    readFileSyncMock.mockReset();
    process.env = { ...originalEnv };
    vi.resetModules();
    const envModule = await import("./env");
    resolveEnv = envModule.resolveEnv;
    requireEnv = envModule.requireEnv;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("prefers values from _FILE when available", () => {
    process.env.TEST_SECRET_FILE = "/tmp/secret";
    process.env.TEST_SECRET = "from-env";
    readFileSyncMock.mockReturnValue(" from-file \n");

    const value = resolveEnv("TEST_SECRET");

    expect(readFileSyncMock).toHaveBeenCalledWith("/tmp/secret", "utf-8");
    expect(value).toBe("from-file");
  });

  it("returns fallback when the variable is not set", () => {
    delete process.env.MISSING_VALUE;

    const value = resolveEnv("MISSING_VALUE", "fallback-value");

    expect(readFileSyncMock).not.toHaveBeenCalled();
    expect(value).toBe("fallback-value");
  });

  it("throws when requireEnv cannot resolve a value", () => {
    delete process.env.REQUIRED_VALUE;

    expect(() => requireEnv("REQUIRED_VALUE")).toThrowError(
      "REQUIRED_VALUE must be configured"
    );
  });
});
