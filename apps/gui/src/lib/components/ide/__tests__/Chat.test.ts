import { render, fireEvent, act, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Chat from '../Chat.svelte';
import {
  MAX_MESSAGE_ID_LENGTH,
  MAX_RENDERED_MESSAGES,
  MAX_STORED_MESSAGES,
  MAX_USER_ID_LENGTH,
  MAX_USER_NAME_LENGTH
} from '../chat.constants';

vi.mock('$lib/config', () => ({ gatewayBaseUrl: 'http://example.com' }));
vi.mock('$lib/stores/notifications', () => ({ notifyError: vi.fn() }));
vi.mock('$lib/stores/session', async () => {
  const { writable } = await import('svelte/store');
  return {
    session: writable({
      authenticated: true,
      info: {
        id: 'user-123',
        name: 'Test User',
        email: 'test@example.com',
        subject: 'user-123',
        roles: [],
        scopes: []
      }
    })
  };
});
vi.mock('$lib/stores/ide', async () => {
  const { writable } = await import('svelte/store');
  return {
    collaborationContext: writable({ tenantId: 'tenant-1', projectId: 'project-1' })
  };
});

const defaultSessionState = {
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

const defaultCollaborationContext = { tenantId: 'tenant-1', projectId: 'project-1' };

async function resetSessionState(newState = defaultSessionState) {
  const sessionStore = await import('$lib/stores/session');
  const mockSession = sessionStore.session as unknown as {
    set: (state: unknown) => void;
  };

  mockSession.set(JSON.parse(JSON.stringify(newState)));
}

async function resetCollaborationContext(newContext = defaultCollaborationContext) {
  const ideStore = await import('$lib/stores/ide');
  const mockContext = ideStore.collaborationContext as unknown as { set: (value: unknown) => void };

  mockContext.set(JSON.parse(JSON.stringify(newContext)));
}

vi.mock('yjs', () => {
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
});

type YjsMockModule = typeof import('yjs') & {
  __mock: {
    yArrayInstances: Array<{
      items: unknown[];
      push: (entries: unknown[]) => void;
      replace: (index: number, entry: unknown) => void;
    }>;
    docInstances: unknown[];
  };
};

vi.mock('y-websocket', () => {
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
});

type WebsocketMockModule = typeof import('y-websocket') & {
  __mock: {
    instances: Array<{
      wsconnected: boolean;
      emit: (event: 'status' | 'connection-error' | 'connection-close' | 'sync', payload: unknown) => void;
    }>;
    setThrowOnConstruct: (value: boolean) => void;
  };
};

afterEach(async () => {
  vi.clearAllMocks();
  const yjsModule = (await import('yjs')) as YjsMockModule;
  const websocketModule = (await import('y-websocket')) as WebsocketMockModule;
  yjsModule.__mock.yArrayInstances.length = 0;
  yjsModule.__mock.docInstances.length = 0;
  websocketModule.__mock.instances.length = 0;
  websocketModule.__mock.setThrowOnConstruct(false);
  await resetSessionState();
  await resetCollaborationContext();
});

beforeEach(async () => {
  await resetSessionState();
  await resetCollaborationContext();
});

describe('Chat collaboration', () => {
  it('refuses to connect when the collaboration context identifiers are unsafe', async () => {
    const ideStore = await import('$lib/stores/ide');
    const context = ideStore.collaborationContext as unknown as { set: (value: unknown) => void };
    context.set({ tenantId: 'tenant id with spaces', projectId: 'project-1' });

    render(Chat);

    expect(
      await screen.findByText('Project context is invalid. Please refresh and retry.')
    ).toBeInTheDocument();

    const websocketModule = (await import('y-websocket')) as WebsocketMockModule;
    expect(websocketModule.__mock.instances).toHaveLength(0);
  });

  it('blocks sending messages until the websocket connection is active', async () => {
    render(Chat);

    const textarea = await screen.findByPlaceholderText('Send a message');
    const yjsModule = (await import('yjs')) as YjsMockModule;
    const messageLog = yjsModule.__mock.yArrayInstances[0];
    const websocketModule = (await import('y-websocket')) as WebsocketMockModule;
    const provider = websocketModule.__mock.instances[0];
    const pushSpy = vi.spyOn(messageLog, 'push');

    await fireEvent.input(textarea, { target: { value: 'Hello while connecting' } });
    await fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(messageLog.items).toHaveLength(0);

    await act(() => provider.emit('status', { status: 'connected' }));
    await tick();
    expect(provider.wsconnected).toBe(true);

    await fireEvent.input(textarea, { target: { value: 'Hello world' } });
    await tick();
    expect((textarea as HTMLTextAreaElement).value).toBe('Hello world');
    const sendButton = await screen.findByRole('button', { name: /send message/i });
    await waitFor(() => expect(sendButton).not.toBeDisabled());
    await fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(pushSpy).toHaveBeenCalled();
    expect(messageLog.items).toHaveLength(1);
    expect((messageLog.items[0] as { text: string }).text).toBe('Hello world');
  });

  it('rejects sending messages when the session user id is invalid', async () => {
    await resetSessionState({
      authenticated: true,
      info: {
        id: 'x'.repeat(MAX_USER_ID_LENGTH + 5),
        name: 'Test User',
        email: 'test@example.com',
        subject: 'user-123',
        roles: [],
        scopes: []
      }
    });

    render(Chat);

    const textarea = await screen.findByPlaceholderText('Send a message');
    const yjsModule = (await import('yjs')) as YjsMockModule;
    const messageLog = yjsModule.__mock.yArrayInstances[0];
    const websocketModule = (await import('y-websocket')) as WebsocketMockModule;
    const provider = websocketModule.__mock.instances[0];
    const notifications = await import('$lib/stores/notifications');

    await act(() => provider.emit('status', { status: 'connected' }));

    await fireEvent.input(textarea, { target: { value: 'Hello world' } });
    await fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(messageLog.items).toHaveLength(0);
    expect(notifications.notifyError).toHaveBeenCalledWith(
      'Your session is invalid. Please sign in again.',
      { timeoutMs: 6000 }
    );
  });

  it('drops malformed incoming messages and sanitizes content', async () => {
    render(Chat);

    const yjsModule = (await import('yjs')) as YjsMockModule;
    const messageLog = yjsModule.__mock.yArrayInstances[0];
    const websocketModule = (await import('y-websocket')) as WebsocketMockModule;
    const provider = websocketModule.__mock.instances[0];

    await act(() => provider.emit('status', { status: 'connected' }));

    const longBody = 'a'.repeat(3000);
    const truncatedBody = 'a'.repeat(2000);
    const oversizedId = 'x'.repeat(MAX_MESSAGE_ID_LENGTH + 10);
    const oversizedUserId = 'y'.repeat(MAX_USER_ID_LENGTH + 5);

    await act(() =>
      messageLog.push([
        { text: 'missing fields' },
        { id: '1', userId: 'user-1', userName: '<script>', text: 'hello', timestamp: Infinity },
        { id: '2', userId: 'user-2', userName: '  ', text: longBody, timestamp: Date.now() },
        {
          id: oversizedId,
          userId: 'user-safe',
          userName: 'Big Id',
          text: 'Should be dropped by id',
          timestamp: Date.now()
        },
        {
          id: 'safe-id',
          userId: oversizedUserId,
          userName: 'Big User',
          text: 'Should be dropped by user id',
          timestamp: Date.now()
        }
      ])
    );

    expect(messageLog.items).toHaveLength(5);
    expect(screen.queryByText('missing fields')).not.toBeInTheDocument();
    expect(screen.queryByText('<script>')).not.toBeInTheDocument();
    expect(screen.getByText(truncatedBody)).toBeInTheDocument();
    expect(screen.getByText('Unknown user')).toBeInTheDocument();
    expect(screen.queryByText('Should be dropped by id')).not.toBeInTheDocument();
    expect(screen.queryByText('Should be dropped by user id')).not.toBeInTheDocument();
  });

  it('strips control characters from outbound and inbound messages', async () => {
    render(Chat);

    const textarea = await screen.findByPlaceholderText('Send a message');
    const yjsModule = (await import('yjs')) as YjsMockModule;
    const messageLog = yjsModule.__mock.yArrayInstances[0];
    const websocketModule = (await import('y-websocket')) as WebsocketMockModule;
    const provider = websocketModule.__mock.instances[0];

    await act(() => provider.emit('status', { status: 'connected' }));

    await fireEvent.input(textarea, { target: { value: 'Hello\u0007\tWorld' } });
    await fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect((messageLog.items[0] as { text: string }).text).toBe('Hello\tWorld');

    const now = Date.now();
    await act(() =>
      messageLog.push([
        {
          id: 'inbound-1',
          userId: 'user-2',
          userName: 'Teammate',
          text: 'Line\u0000One\nLine\u0001Two',
          timestamp: now
        }
      ])
    );

    const rendered = screen.getByText(/LineOne/);
    expect(rendered.textContent).toBe('LineOne\nLineTwo');
  });

  it('removes control characters from message drafts as users type', async () => {
    render(Chat);

    const textarea = await screen.findByPlaceholderText('Send a message');

    await fireEvent.input(textarea, { target: { value: 'Draft\u0000Body' } });

    expect((textarea as HTMLTextAreaElement).value).toBe('DraftBody');
  });

  it('refreshes the connected message when the session identity changes', async () => {
    render(Chat);

    const websocketModule = (await import('y-websocket')) as WebsocketMockModule;
    const provider = websocketModule.__mock.instances[0];

    await act(() => provider.emit('status', { status: 'connected' }));

    expect(
      screen.getByText('You are live as Test User. Messages sync instantly across collaborators.')
    ).toBeInTheDocument();

    await act(() =>
      resetSessionState({
        authenticated: true,
        info: {
          id: 'user-999',
          name: 'Updated User',
          email: 'updated@example.com',
          subject: 'user-999',
          roles: [],
          scopes: []
        }
      })
    );

    expect(
      screen.getByText('You are live as Updated User. Messages sync instantly across collaborators.')
    ).toBeInTheDocument();
  });

  it('updates the identity badge when the session name changes', async () => {
    render(Chat);

    expect(screen.getByText('Test User')).toBeInTheDocument();
    expect(screen.getByText('T', { selector: '.chip-avatar' })).toBeInTheDocument();

    await act(() =>
      resetSessionState({
        authenticated: true,
        info: {
          id: 'user-555',
          name: 'New Teammate',
          email: 'new@example.com',
          subject: 'user-555',
          roles: [],
          scopes: []
        }
      })
    );

    expect(screen.getByText('New Teammate')).toBeInTheDocument();
    expect(screen.getByText('N', { selector: '.chip-avatar' })).toBeInTheDocument();
  });

  it('falls back to a safe user name when the session identity is invalid', async () => {
    render(Chat);

    await act(() =>
      resetSessionState({
        authenticated: true,
        info: {
          id: 'user-unsafe',
          name: 12345 as unknown as string,
          email: '',
          subject: '',
          roles: [],
          scopes: []
        }
      })
    );

    expect(screen.getByText('User')).toBeInTheDocument();
    expect(screen.getByText('U', { selector: '.chip-avatar' })).toBeInTheDocument();

    const yjsModule = (await import('yjs')) as YjsMockModule;
    const messageLog = yjsModule.__mock.yArrayInstances[0];
    const websocketModule = (await import('y-websocket')) as WebsocketMockModule;
    const provider = websocketModule.__mock.instances[0];
    const textarea = await screen.findByPlaceholderText('Send a message');

    await act(() => provider.emit('status', { status: 'connected' }));
    await fireEvent.input(textarea, { target: { value: 'Hello secure world' } });
    await fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect((messageLog.items[0] as { userName: string }).userName).toBe('User');
  });

  it('obfuscates email-based fallbacks to avoid leaking full addresses', async () => {
    await act(() =>
      resetSessionState({
        authenticated: true,
        info: {
          id: 'user-email',
          name: '',
          email: 'person@example.com',
          subject: '',
          roles: [],
          scopes: []
        }
      })
    );

    render(Chat);

    const obfuscated = 'p***@e***e.c***m';

    expect(screen.getByText(obfuscated)).toBeInTheDocument();
    expect(screen.getByText('P', { selector: '.chip-avatar' })).toBeInTheDocument();

    const yjsModule = (await import('yjs')) as YjsMockModule;
    const messageLog = yjsModule.__mock.yArrayInstances[0];
    const websocketModule = (await import('y-websocket')) as WebsocketMockModule;
    const provider = websocketModule.__mock.instances[0];
    const textarea = await screen.findByPlaceholderText('Send a message');

    await act(() => provider.emit('status', { status: 'connected' }));
    await fireEvent.input(textarea, { target: { value: 'Email safe message' } });
    await fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect((messageLog.items[0] as { userName: string }).userName).toBe(obfuscated);
  });

  it('obfuscates session names that look like emails before displaying or sending', async () => {
    await act(() =>
      resetSessionState({
        authenticated: true,
        info: {
          id: 'user-email-name',
          name: 'contact@example.com',
          email: 'contact@example.com',
          subject: '',
          roles: [],
          scopes: []
        }
      })
    );

    render(Chat);

    const obfuscated = 'c***@e***e.c***m';

    expect(screen.getByText(obfuscated)).toBeInTheDocument();

    const yjsModule = (await import('yjs')) as YjsMockModule;
    const messageLog = yjsModule.__mock.yArrayInstances[0];
    const websocketModule = (await import('y-websocket')) as WebsocketMockModule;
    const provider = websocketModule.__mock.instances[0];
    const textarea = await screen.findByPlaceholderText('Send a message');

    await act(() => provider.emit('status', { status: 'connected' }));
    await fireEvent.input(textarea, { target: { value: 'Email-like name safe' } });
    await fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect((messageLog.items[0] as { userName: string }).userName).toBe(obfuscated);
  });

  it('obfuscates inbound message author emails before rendering', async () => {
    render(Chat);

    const yjsModule = (await import('yjs')) as YjsMockModule;
    const messageLog = yjsModule.__mock.yArrayInstances[0];

    await act(() =>
      messageLog.push([
        {
          id: 'msg-1',
          userId: 'remote-user',
          userName: 'person@example.com',
          text: 'Hello from email name',
          timestamp: Date.now()
        }
      ])
    );

    expect(screen.getByText('p***@e***e.c***m')).toBeInTheDocument();
    expect(screen.queryByText('person@example.com')).not.toBeInTheDocument();
  });

  it('truncates overly long session names before sending messages', async () => {
    render(Chat);

    const longName = 'A'.repeat(MAX_USER_NAME_LENGTH + 25);
    const expected = longName.slice(0, MAX_USER_NAME_LENGTH);

    await act(() =>
      resetSessionState({
        authenticated: true,
        info: {
          id: 'user-long',
          name: longName,
          email: '',
          subject: '',
          roles: [],
          scopes: []
        }
      })
    );

    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.getByText('A', { selector: '.chip-avatar' })).toBeInTheDocument();

    const yjsModule = (await import('yjs')) as YjsMockModule;
    const messageLog = yjsModule.__mock.yArrayInstances[0];
    const websocketModule = (await import('y-websocket')) as WebsocketMockModule;
    const provider = websocketModule.__mock.instances[0];
    const textarea = await screen.findByPlaceholderText('Send a message');

    await act(() => provider.emit('status', { status: 'connected' }));
    await fireEvent.input(textarea, { target: { value: 'Hello secure world' } });
    await fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect((messageLog.items[0] as { userName: string }).userName).toBe(expected);
  });

  it('rejects outbound messages that exceed the maximum length', async () => {
    render(Chat);

    const textarea = await screen.findByPlaceholderText('Send a message');
    const yjsModule = (await import('yjs')) as YjsMockModule;
    const messageLog = yjsModule.__mock.yArrayInstances[0];
    const websocketModule = (await import('y-websocket')) as WebsocketMockModule;
    const provider = websocketModule.__mock.instances[0];
    const notifications = await import('$lib/stores/notifications');

    await act(() => provider.emit('status', { status: 'connected' }));

    const longMessage = 'x'.repeat(2500);
    await fireEvent.input(textarea, { target: { value: longMessage } });
    await fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(messageLog.items).toHaveLength(0);
    expect(notifications.notifyError).toHaveBeenCalled();
  });

  it('tears down attempted connections that fail during initialization', async () => {
    const websocketModule = (await import('y-websocket')) as WebsocketMockModule;
    websocketModule.__mock.setThrowOnConstruct(true);

    render(Chat);

    expect(await screen.findByText('Unable to start chat collaboration. Please retry.')).toBeInTheDocument();

    const yjsModule = (await import('yjs')) as YjsMockModule;
    expect(yjsModule.__mock.docInstances).toHaveLength(0);
    expect(yjsModule.__mock.yArrayInstances).toHaveLength(0);
  });

  it('renders only the most recent messages to avoid expensive history reflows', async () => {
    render(Chat);

    const yjsModule = (await import('yjs')) as YjsMockModule;
    const messageLog = yjsModule.__mock.yArrayInstances[0];
    const websocketModule = (await import('y-websocket')) as WebsocketMockModule;
    const provider = websocketModule.__mock.instances[0];

    await act(() => provider.emit('status', { status: 'connected' }));

    const totalMessages = MAX_RENDERED_MESSAGES + 5;
    const payload = Array.from({ length: totalMessages }, (_, index) => ({
      id: `m-${index}`,
      userId: `user-${index}`,
      userName: `User ${index}`,
      text: `message ${index}`,
      timestamp: Date.now() + index
    }));

    await act(() => messageLog.push(payload));

    expect(screen.queryByText('message 0')).not.toBeInTheDocument();
    expect(screen.getByText(`message ${totalMessages - 1}`)).toBeInTheDocument();
  });

  it('refreshes cached message renders when entries change in place', async () => {
    render(Chat);

    const yjsModule = (await import('yjs')) as YjsMockModule;
    const messageLog = yjsModule.__mock.yArrayInstances[0];
    const websocketModule = (await import('y-websocket')) as WebsocketMockModule;
    const provider = websocketModule.__mock.instances[0];

    await act(() => provider.emit('status', { status: 'connected' }));

    const initial = {
      id: 'm-1',
      userId: 'user-1',
      userName: 'Old Name',
      text: 'first draft',
      timestamp: Date.now()
    };

    await act(() => messageLog.push([initial]));

    expect(screen.getByText('first draft')).toBeInTheDocument();
    expect(screen.getByText('Old Name')).toBeInTheDocument();

    const updated = {
      ...initial,
      userName: 'New Name',
      text: 'final message',
      timestamp: initial.timestamp + 1
    };

    await act(() => messageLog.replace(0, updated));

    expect(screen.queryByText('first draft')).not.toBeInTheDocument();
    expect(screen.getByText('final message')).toBeInTheDocument();
    expect(screen.getByText('New Name')).toBeInTheDocument();
  });

  it('prunes stored chat history to avoid unbounded retention', async () => {
    render(Chat);

    const yjsModule = (await import('yjs')) as YjsMockModule;
    const messageLog = yjsModule.__mock.yArrayInstances[0];
    const websocketModule = (await import('y-websocket')) as WebsocketMockModule;
    const provider = websocketModule.__mock.instances[0];

    await act(() => provider.emit('status', { status: 'connected' }));

    const totalMessages = MAX_STORED_MESSAGES + 25;
    const payload = Array.from({ length: totalMessages }, (_, index) => ({
      id: `m-${index}`,
      userId: `user-${index}`,
      userName: `User ${index}`,
      text: `payload ${index}`,
      timestamp: Date.now() + index
    }));

    await act(() => messageLog.push(payload));

    expect(messageLog.items).toHaveLength(MAX_STORED_MESSAGES);
    expect((messageLog.items[0] as { id: string }).id).toBe(
      `m-${totalMessages - MAX_STORED_MESSAGES}`
    );
    expect(screen.queryByText('payload 0')).not.toBeInTheDocument();
    expect(screen.getByText(`payload ${totalMessages - 1}`)).toBeInTheDocument();
  });
});
