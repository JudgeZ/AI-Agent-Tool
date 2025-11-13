export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, context?: unknown): void;
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
}

export type ConsoleWriter = (message?: string) => void;

type ConsoleLike = Partial<Pick<Console, 'debug' | 'info' | 'warn' | 'error' | 'log'>>;

type Clock = () => string;

export interface CreateLoggerOptions {
  name?: string;
  console?: ConsoleLike;
  clock?: Clock;
}

type ResolvedOptions = {
  name?: string;
  console: ConsoleLike;
  clock: Clock;
};

function resolveName(name?: string): string | undefined {
  if (typeof name !== 'string') {
    return undefined;
  }
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveConsole(options?: ConsoleLike): ConsoleLike {
  const fallback = globalThis.console ?? { log: () => {} };
  if (!options) {
    return fallback;
  }
  return { ...fallback, ...options };
}

function resolveClock(clock?: Clock): Clock {
  if (clock) {
    return clock;
  }
  return () => new Date().toISOString();
}

function normalizeContext(context: unknown): unknown {
  if (context == null) {
    return undefined;
  }
  if (context instanceof Error) {
    const normalized: Record<string, unknown> = {
      message: context.message
    };
    if (context.name) {
      normalized.name = context.name;
    }
    if (context.stack) {
      normalized.stack = context.stack;
    }
    const cause = (context as Error & { cause?: unknown }).cause;
    if (cause !== undefined) {
      normalized.cause = cause instanceof Error ? normalizeContext(cause) : cause;
    }
    return normalized;
  }
  if (Array.isArray(context)) {
    return context.length > 0 ? context : undefined;
  }
  if (typeof context === 'object') {
    const entries = Object.entries(context).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
      return undefined;
    }
    return Object.fromEntries(entries);
  }
  return context;
}

function formatPayload(level: LogLevel, message: string, options: ResolvedOptions, context?: unknown): string {
  const payload: Record<string, unknown> = {
    level,
    msg: message,
    time: options.clock()
  };
  if (options.name) {
    payload.name = options.name;
  }
  const normalized = normalizeContext(context);
  if (normalized !== undefined) {
    payload.context = normalized;
  }
  return JSON.stringify(payload);
}

function resolveWriter(level: LogLevel, consoleLike: ConsoleLike): ConsoleWriter {
  const writer =
    (level === 'debug' ? consoleLike.debug : undefined) ??
    (level === 'info' ? consoleLike.info : undefined) ??
    (level === 'warn' ? consoleLike.warn : undefined) ??
    (level === 'error' ? consoleLike.error : undefined) ??
    consoleLike.log;
  if (writer) {
    return writer.bind(consoleLike) as ConsoleWriter;
  }
  const fallback = (globalThis.console?.log ?? (() => {})).bind(globalThis.console);
  return fallback as ConsoleWriter;
}

function emit(level: LogLevel, message: string, context: unknown, options: ResolvedOptions): void {
  const writer = resolveWriter(level, options.console);
  writer(formatPayload(level, message, options, context));
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const resolved: ResolvedOptions = {
    name: resolveName(options.name),
    console: resolveConsole(options.console),
    clock: resolveClock(options.clock)
  };

  return {
    debug(message: string, context?: unknown) {
      emit('debug', message, context, resolved);
    },
    info(message: string, context?: unknown) {
      emit('info', message, context, resolved);
    },
    warn(message: string, context?: unknown) {
      emit('warn', message, context, resolved);
    },
    error(message: string, context?: unknown) {
      emit('error', message, context, resolved);
    }
  };
}

export const logger: Logger = createLogger({ name: 'gui' });

export default logger;
