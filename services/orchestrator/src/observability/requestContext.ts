import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  requestId: string;
  traceId: string;
  actorId?: string;
};

const supportsAsyncLocalStorage = typeof AsyncLocalStorage === "function";
const storage = supportsAsyncLocalStorage
  ? new AsyncLocalStorage<RequestContext>()
  : undefined;

let fallbackContext: RequestContext | undefined;

function getActiveContext(): RequestContext | undefined {
  return storage?.getStore() ?? fallbackContext;
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export function runWithContext<T>(context: RequestContext, fn: () => T): T;
export function runWithContext<T>(
  context: RequestContext,
  fn: () => Promise<T>,
): Promise<T>;
export function runWithContext<T>(
  context: RequestContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  if (storage) {
    return storage.run(context, fn);
  }

  fallbackContext = context;

  try {
    const result = fn();
    if (isPromiseLike(result)) {
      return result.finally(() => {
        fallbackContext = undefined;
      });
    }
    fallbackContext = undefined;
    return result;
  } catch (error) {
    fallbackContext = undefined;
    throw error;
  }
}

export function getRequestContext(): RequestContext | undefined {
  return getActiveContext();
}

export function setRequestContext(context: RequestContext): void {
  if (storage) {
    const current = storage.getStore();
    if (current) {
      current.requestId = context.requestId;
      current.traceId = context.traceId;
      current.actorId = context.actorId;
      return;
    }
    storage.enterWith(context);
  }
  fallbackContext = context;
}

export function setActorInContext(actorId: string): void {
  const context = getActiveContext();
  if (!context) {
    return;
  }
  context.actorId = actorId;
}

export function updateContextIdentifiers(update: {
  requestId?: string;
  traceId?: string;
}): void {
  const context = getActiveContext();
  if (!context) {
    if (update.requestId && update.traceId) {
      setRequestContext({
        requestId: update.requestId,
        traceId: update.traceId,
        actorId: undefined,
      });
    }
    return;
  }

  if (update.requestId) {
    context.requestId = update.requestId;
  }
  if (update.traceId) {
    context.traceId = update.traceId;
  }
}

