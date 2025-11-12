import pino, { type LoggerOptions, stdTimeFunctions, type Logger as PinoLogger } from "pino";

export type LoggerBindings = Record<string, unknown>;

export type AppLogger = PinoLogger;

export type NormalizedError = {
  message: string;
  name?: string;
  stack?: string;
  code?: string | number;
  cause?: unknown;
  details?: Record<string, unknown>;
};

type CreateLoggerOptions = {
  level?: string;
  serviceName?: string;
  bindings?: LoggerBindings;
  options?: LoggerOptions;
};

function resolveLevel(): string {
  const envLevel = process.env.LOG_LEVEL?.trim();
  return envLevel && envLevel.length > 0 ? envLevel : "info";
}

function resolveServiceName(): string {
  const envName = process.env.SERVICE_NAME?.trim();
  return envName && envName.length > 0 ? envName : "orchestrator";
}

function buildLoggerOptions(overrides?: LoggerOptions): LoggerOptions {
  const base: LoggerOptions = {
    level: resolveLevel(),
    base: { service: resolveServiceName() },
    timestamp: stdTimeFunctions.isoTime,
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
  };
  return overrides ? { ...base, ...overrides } : base;
}

export function createLogger(options: CreateLoggerOptions = {}): AppLogger {
  const loggerOptions = buildLoggerOptions(options.options);
  if (options.level) {
    loggerOptions.level = options.level;
  }
  if (options.serviceName) {
    loggerOptions.base = { ...(loggerOptions.base ?? {}), service: options.serviceName };
  }
  const logger = pino(loggerOptions);
  if (options.bindings && Object.keys(options.bindings).length > 0) {
    return logger.child(options.bindings);
  }
  return logger;
}

export const appLogger: AppLogger = createLogger({ bindings: { subsystem: "orchestrator" } });
export default appLogger;

function extractCode(error: unknown): string | number | undefined {
  if (typeof error === "object" && error !== null) {
    const candidate = (error as Record<string, unknown>).code;
    if (typeof candidate === "string" || typeof candidate === "number") {
      return candidate;
    }
  }
  return undefined;
}

function extractDetails(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const plain = error as Record<string, unknown>;
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plain)) {
    if (key === "message" || key === "name" || key === "stack" || key === "code" || key === "cause") {
      continue;
    }
    details[key] = value;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

export function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    const normalized: NormalizedError = {
      message: error.message,
      name: error.name,
    };
    if (error.stack) {
      normalized.stack = error.stack;
    }
    const code = extractCode(error);
    if (code !== undefined) {
      normalized.code = code;
    }
    const cause = readCause(error);
    if (cause !== undefined) {
      normalized.cause = cause instanceof Error ? normalizeError(cause) : cause;
    }
    const details = extractDetails(error);
    if (details) {
      normalized.details = details;
    }
    return normalized;
  }

  if (typeof error === "string") {
    return { message: error };
  }

  if (typeof error === "object" && error !== null) {
    const plain = error as Record<string, unknown>;
    const message = typeof plain.message === "string" && plain.message.trim().length > 0
      ? plain.message
      : safeStringify(plain) ?? "Unknown error";
    const normalized: NormalizedError = { message };
    if (typeof plain.name === "string") {
      normalized.name = plain.name;
    }
    if (typeof plain.stack === "string") {
      normalized.stack = plain.stack;
    }
    const code = extractCode(plain);
    if (code !== undefined) {
      normalized.code = code;
    }
    const cause = readCause(plain);
    if (cause !== undefined) {
      normalized.cause = cause instanceof Error ? normalizeError(cause) : cause;
    }
    const details = extractDetails(plain);
    if (details) {
      normalized.details = details;
    }
    return normalized;
  }

  return { message: safeStringify(error) ?? String(error) };
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function readCause(value: unknown): unknown | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  if ("cause" in value) {
    return (value as { cause?: unknown }).cause;
  }
  return undefined;
}
