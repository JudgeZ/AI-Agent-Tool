'use strict';

const LEVEL_TO_CONSOLE = {
  debug: console.debug || console.log,
  info: console.info || console.log,
  warn: console.warn || console.log,
  error: console.error || console.log
};

function normalizeContext(context) {
  if (context == null) {
    return undefined;
  }
  if (context instanceof Error) {
    return {
      message: context.message,
      stack: context.stack
    };
  }
  if (typeof context === 'object') {
    if (Array.isArray(context)) {
      return context.length === 0 ? undefined : context;
    }
    const entries = Object.entries(context).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
      return undefined;
    }
    return Object.fromEntries(entries);
  }
  return context;
}

function formatLog(level, name, message, context) {
  const payload = {
    level,
    msg: message,
    time: new Date().toISOString()
  };
  if (name) {
    payload.name = name;
  }
  if (context !== undefined) {
    payload.context = context;
  }
  return JSON.stringify(payload);
}

function emit(level, name, message, context) {
  const normalized = normalizeContext(context);
  const line = formatLog(level, name, message, normalized);
  const writer = LEVEL_TO_CONSOLE[level] || console.log;
  writer(line);
}

function createLogger(options = {}) {
  const { name = '' } = options;

  return {
    debug(message, context) {
      emit('debug', name, message, context);
    },
    info(message, context) {
      emit('info', name, message, context);
    },
    warn(message, context) {
      emit('warn', name, message, context);
    },
    error(message, context) {
      emit('error', name, message, context);
    }
  };
}

module.exports = { createLogger };
module.exports.default = module.exports;
