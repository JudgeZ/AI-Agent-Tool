import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  requestId: string;
  traceId?: string;
  actorId?: string;
  subject?: {
    sessionId?: string;
    userId?: string;
    tenantId?: string;
    email?: string | null;
    name?: string | null;
    roles?: string[];
    scopes?: string[];
  };
  metadata?: Record<string, unknown>;
};

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function updateRequestContext(update: Partial<RequestContext>): void {
  const context = storage.getStore();
  if (!context) {
    return;
  }
  Object.assign(context, update);
}

export function setActorInContext(actorId: string): void {
  const context = storage.getStore();
  if (!context) {
    return;
  }
  context.actorId = actorId;
}

