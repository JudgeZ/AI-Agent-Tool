import { readFileSync } from "node:fs";

function readFileValue(path: string): string | undefined {
  try {
    const content = readFileSync(path, "utf-8").trim();
    return content.length > 0 ? content : undefined;
  } catch {
    return undefined;
  }
}

export function resolveEnv(
  name: string,
  fallback?: string,
): string | undefined {
  const filePath = process.env[`${name}_FILE`];
  if (filePath) {
    const fromFile = readFileValue(filePath);
    if (fromFile !== undefined) {
      return fromFile;
    }
  }
  const direct = process.env[name];
  if (direct !== undefined && direct !== "") {
    return direct;
  }
  return fallback;
}

export function requireEnv(name: string): string {
  const value = resolveEnv(name);
  if (value === undefined) {
    throw new Error(`${name} must be configured`);
  }
  return value;
}
