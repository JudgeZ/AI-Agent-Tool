import { vi } from 'vitest';
import { obfuscateEmail } from '../../chat.sanitization';

export const defaultSessionState = {
  authenticated: true,
  info: {
    id: 'user-123',
    name: 'Test User',
    email: 'test@example.com',
    subject: 'user-123',
    roles: [],
    scopes: []
  }
};

export const defaultCollaborationContext = { tenantId: 'tenant-1', projectId: 'project-1' };

export const createSessionMock = async () => {
  const { writable } = await import('svelte/store');
  const store = writable(structuredClone(defaultSessionState));

  return {
    session: store
  };
};

export const createCollaborationContextMock = async () => {
  const { writable } = await import('svelte/store');
  const store = writable(structuredClone(defaultCollaborationContext));

  return {
    collaborationContext: store
  };
};

export async function resetSessionState(newState = defaultSessionState) {
  const sessionStore = await import('$lib/stores/session');
  const mockSession = sessionStore.session as unknown as {
    set: (state: unknown) => void;
  };

  mockSession.set(structuredClone(newState));
}

export async function resetCollaborationContext(newContext = defaultCollaborationContext) {
  const ideStore = await import('$lib/stores/ide');
  const mockContext = ideStore.collaborationContext as unknown as { set: (value: unknown) => void };

  mockContext.set(structuredClone(newContext));
}

export const createYjsMock = () => {
  type YArrayInstance = {
    items: unknown[];
    push: (entries: unknown[]) => void;
    replace: (index: number, entry: unknown) => void;
  };

  const yArrayInstances: YArrayInstance[] = [];
  const docInstances: unknown[] = [];

  class MockYArray<T> {
    items: T[] = [];
    private observers = new Set<() => void>();

    constructor() {
      yArrayInstances.push(this as unknown as MockYArray<unknown>);
    }

    get length() {
      return this.items.length;
    }

    get(index: number) {
      return this.items[index];
    }

    toArray() {
      return [...this.items];
    }

    slice(start?: number, end?: number) {
      return this.items.slice(start, end);
    }

    delete(index: number, length: number) {
      this.items.splice(index, length);
      this.observers.forEach((observer) => observer());
    }

    replace(index: number, entry: T) {
      this.items.splice(index, 1, entry);
      this.observers.forEach((observer) => observer());
    }

    push(entries: T[]) {
      this.items.push(...entries);
      this.observers.forEach((observer) => observer());
    }

    observe(callback: () => void) {
      this.observers.add(callback);
    }

    unobserve(callback: () => void) {
      this.observers.delete(callback);
    }
  }

  class MockDoc {
    readonly array = new MockYArray<unknown>();

    constructor() {
      docInstances.push(this as unknown as MockDoc);
    }

    getArray<T>() {
      return this.array as unknown as MockYArray<T>;
    }

    transact(fn: () => void) {
      fn();
    }

    destroy() {
      const arrayIndex = yArrayInstances.indexOf(this.array as unknown as YArrayInstance);
      if (arrayIndex !== -1) {
        yArrayInstances.splice(arrayIndex, 1);
      }
      const index = docInstances.indexOf(this as unknown as MockDoc);
      if (index !== -1) {
        docInstances.splice(index, 1);
      }
    }
  }

  return {
    Doc: MockDoc,
    Array: MockYArray,
    __mock: { yArrayInstances, docInstances }
  };
};

export const createWebsocketProviderMock = () => {
  type ProviderEvent = 'status' | 'connection-error' | 'connection-close' | 'sync';

  type ProviderPayload = {
    status: { status: 'connected' | 'disconnected' | 'connecting' };
    'connection-error': Event;
    'connection-close': CloseEvent | null;
    sync: boolean;
  };

  const instances: Array<{
    wsconnected: boolean;
    emit: (event: ProviderEvent, payload: ProviderPayload[ProviderEvent]) => void;
  }> = [];
  let throwOnConstruct = false;

  class MockWebsocketProvider {
    handlers: Record<ProviderEvent, Array<(payload: ProviderPayload[ProviderEvent]) => void>> = {
      status: [],
      'connection-error': [],
      'connection-close': [],
      sync: []
    };
    wsconnected = false;

    constructor(
      public readonly serverUrl: string,
      public readonly roomname: string,
      public readonly doc: unknown,
      public readonly opts: { maxBackoffTime?: number }
    ) {
      if (throwOnConstruct) {
        throw new Error('mock connect failure');
      }
      instances.push(this);
    }

    on(event: ProviderEvent, handler: (payload: ProviderPayload[typeof event]) => void) {
      this.handlers[event]?.push(handler as (payload: ProviderPayload[ProviderEvent]) => void);
    }

    emit<K extends ProviderEvent>(event: K, payload: ProviderPayload[K]) {
      if (event === 'status') {
        const statusPayload = payload as ProviderPayload['status'];
        this.wsconnected = statusPayload?.status === 'connected';
      }
      this.handlers[event]?.forEach((handler) => handler(payload));
    }

    destroy() {
      this.wsconnected = false;
      Object.keys(this.handlers).forEach((key) => {
        this.handlers[key as ProviderEvent] = [];
      });
    }
  }

  return {
    WebsocketProvider: MockWebsocketProvider,
    __mock: {
      instances,
      setThrowOnConstruct: (value: boolean) => {
        throwOnConstruct = value;
      }
    }
  };
};

export async function clearCollaborationMocks() {
  const yjsModule = (await import('yjs')) as unknown as {
    __mock: { yArrayInstances: unknown[]; docInstances: unknown[] };
  };
  const websocketModule = (await import('y-websocket')) as unknown as {
    __mock: { instances: unknown[]; setThrowOnConstruct: (value: boolean) => void };
  };
  yjsModule.__mock.yArrayInstances.length = 0;
  yjsModule.__mock.docInstances.length = 0;
  websocketModule.__mock.instances.length = 0;
  websocketModule.__mock.setThrowOnConstruct(false);
}

export function buildObfuscatedExpectation(email: string) {
  return obfuscateEmail(email);
}

export function buildLongMessage(length: number, fill = 'x') {
  return fill.repeat(length);
}

export const latestWebsocketProvider = async () => {
  const websocketModule = (await import('y-websocket')) as unknown as {
    __mock: { instances: Array<{ wsconnected: boolean }> };
  };
  const { instances } = websocketModule.__mock;
  const provider = instances.at(-1);
  if (!provider) {
    throw new Error('websocket provider not initialized');
  }
  return provider;
};

export const latestMessageLog = async () => {
  const yjsModule = (await import('yjs')) as unknown as {
    __mock: { yArrayInstances: Array<{ items: unknown[] }> };
  };
  const { yArrayInstances } = yjsModule.__mock;
  const array = yArrayInstances.at(-1);
  if (!array) {
    throw new Error('message log not initialized');
  }
  return array;
};

// Note: JSON-based structuredClone fallback does not support functions, symbols, circular refs, or special objects.
vi.stubGlobal('structuredClone', globalThis.structuredClone ?? ((value: unknown) => JSON.parse(JSON.stringify(value))));
