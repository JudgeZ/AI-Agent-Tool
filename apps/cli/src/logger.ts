import pino, { stdTimeFunctions, type Logger as PinoLogger, type LoggerOptions } from "pino";

export type LoggerBindings = Record<string, unknown>;

export type CliLogger = PinoLogger;

interface CreateLoggerOptions {
  level?: string;
  serviceName?: string;
  bindings?: LoggerBindings;
  options?: LoggerOptions;
}

function resolveLevel(): string {
  const envLevel = process.env.AIDT_LOG_LEVEL ?? process.env.LOG_LEVEL;
  if (typeof envLevel === "string" && envLevel.trim().length > 0) {
    return envLevel.trim();
  }
  return "info";
}

function resolveServiceName(): string {
  const envName = process.env.AIDT_SERVICE_NAME ?? process.env.SERVICE_NAME;
  if (typeof envName === "string" && envName.trim().length > 0) {
    return envName.trim();
  }
  return "cli";
}

function buildLoggerOptions(overrides?: LoggerOptions): LoggerOptions {
  const baseOptions: LoggerOptions = {
    level: resolveLevel(),
    base: { service: resolveServiceName() },
    timestamp: stdTimeFunctions.isoTime,
    formatters: {
      level(label: string) {
        return { level: label };
      }
    }
  };
  return overrides ? { ...baseOptions, ...overrides } : baseOptions;
}

export function createLogger(options: CreateLoggerOptions = {}): CliLogger {
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

export const logger: CliLogger = createLogger({ bindings: { subsystem: "cli" } });
