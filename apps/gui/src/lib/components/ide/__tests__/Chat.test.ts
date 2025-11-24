import { render, fireEvent, act, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Chat from '../Chat.svelte';
import {
  MAX_MESSAGE_ID_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_RENDERED_MESSAGES,
  MAX_STORED_MESSAGES,
  MAX_USER_ID_LENGTH,
  MAX_USER_NAME_LENGTH
} from '../chat.constants';
import {
  buildLongMessage,
  buildObfuscatedExpectation,
  clearCollaborationMocks,
  latestMessageLog,
  latestWebsocketProvider,
  resetCollaborationContext,
  resetSessionState
} from './support/chatMocks';

vi.mock('$lib/config', () => ({ gatewayBaseUrl: 'http://example.com' }));
vi.mock('$lib/stores/notifications', () => ({ notifyError: vi.fn() }));
vi.mock('$lib/stores/session', async () => (await import('./support/chatMocks')).createSessionMock());
vi.mock('$lib/stores/ide', async () => (await import('./support/chatMocks')).createCollaborationContextMock());

vi.mock('yjs', async () => (await import('./support/chatMocks')).createYjsMock());
vi.mock('y-websocket', async () => (await import('./support/chatMocks')).createWebsocketProviderMock());

afterEach(async () => {
  vi.clearAllMocks();
  await clearCollaborationMocks();
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

    const websocketModule = await import('y-websocket');
    expect((websocketModule as unknown as { __mock: { instances: unknown[] } }).__mock.instances).toHaveLength(0);
  });

  it('blocks sending messages until the websocket connection is active', async () => {
    render(Chat);

    const textarea = await screen.findByPlaceholderText('Send a message');
    const messageLog = await latestMessageLog();
    const provider = await latestWebsocketProvider();
    const pushSpy = vi.spyOn(messageLog as { push: (entries: unknown[]) => void }, 'push');
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
    const messageLog = await latestMessageLog();
    const provider = await latestWebsocketProvider();
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

    const messageLog = await latestMessageLog();
    const provider = await latestWebsocketProvider();

    await act(() => provider.emit('status', { status: 'connected' }));

    const longBody = buildLongMessage(MAX_MESSAGE_LENGTH + 1000, 'a');
    const truncatedBody = buildLongMessage(MAX_MESSAGE_LENGTH, 'a');
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
    const messageLog = await latestMessageLog();
    const provider = await latestWebsocketProvider();

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

    const provider = await latestWebsocketProvider();

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

    const messageLog = await latestMessageLog();
    const provider = await latestWebsocketProvider();
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

    const obfuscated = buildObfuscatedExpectation('person@example.com');

    expect(screen.getByText(obfuscated)).toBeInTheDocument();
    expect(screen.getByText('P', { selector: '.chip-avatar' })).toBeInTheDocument();

    const messageLog = await latestMessageLog();
    const provider = await latestWebsocketProvider();
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

    const obfuscated = buildObfuscatedExpectation('contact@example.com');

    expect(screen.getByText(obfuscated)).toBeInTheDocument();

    const messageLog = await latestMessageLog();
    const provider = await latestWebsocketProvider();
    const textarea = await screen.findByPlaceholderText('Send a message');

    await act(() => provider.emit('status', { status: 'connected' }));
    await fireEvent.input(textarea, { target: { value: 'Email-like name safe' } });
    await fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect((messageLog.items[0] as { userName: string }).userName).toBe(obfuscated);
  });

  it('obfuscates inbound message author emails before rendering', async () => {
    render(Chat);

    const messageLog = await latestMessageLog();

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

  it('retains domains with multiple at symbols when obfuscating emails', async () => {
    await act(() =>
      resetSessionState({
        authenticated: true,
        info: {
          id: 'user-at',
          name: '',
          email: 'local@subdomain@example.com',
          subject: '',
          roles: [],
          scopes: []
        }
      })
    );

    render(Chat);

    const expected = buildObfuscatedExpectation('local@subdomain@example.com');
    expect(screen.getByText(expected)).toBeInTheDocument();

    const messageLog = await latestMessageLog();
    const provider = await latestWebsocketProvider();
    const textarea = await screen.findByPlaceholderText('Send a message');

    await act(() => provider.emit('status', { status: 'connected' }));
    await fireEvent.input(textarea, { target: { value: 'Multiple at signs' } });
    await fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect((messageLog.items[0] as { userName: string }).userName).toBe(expected);
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

    const messageLog = await latestMessageLog();
    const provider = await latestWebsocketProvider();
    const textarea = await screen.findByPlaceholderText('Send a message');

    await act(() => provider.emit('status', { status: 'connected' }));
    await fireEvent.input(textarea, { target: { value: 'Hello secure world' } });
    await fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect((messageLog.items[0] as { userName: string }).userName).toBe(expected);
  });

  it('rejects outbound messages that exceed the maximum length', async () => {
    render(Chat);

    const textarea = await screen.findByPlaceholderText('Send a message');
    const messageLog = await latestMessageLog();
    const provider = await latestWebsocketProvider();
    const notifications = await import('$lib/stores/notifications');

    await act(() => provider.emit('status', { status: 'connected' }));

    const longMessage = buildLongMessage(MAX_MESSAGE_LENGTH + 500);
    await fireEvent.input(textarea, { target: { value: longMessage } });
    await fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(messageLog.items).toHaveLength(0);
    expect(notifications.notifyError).toHaveBeenCalled();
  });

  it('tears down attempted connections that fail during initialization', async () => {
    const websocketModule = await import('y-websocket');
    (websocketModule as unknown as { __mock: { setThrowOnConstruct: (value: boolean) => void } }).__mock.setThrowOnConstruct(
      true
    );

    render(Chat);

    expect(await screen.findByText('Unable to start chat collaboration. Please retry.')).toBeInTheDocument();

    const yjsModule = await import('yjs');
    const mock = yjsModule as unknown as { __mock: { docInstances: unknown[]; yArrayInstances: unknown[] } };
    expect(mock.__mock.docInstances).toHaveLength(0);
    expect(mock.__mock.yArrayInstances).toHaveLength(0);
  });

  it('renders only the most recent messages to avoid expensive history reflows', async () => {
    render(Chat);

    const messageLog = await latestMessageLog();
    const provider = await latestWebsocketProvider();

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

    const messageLog = await latestMessageLog();
    const provider = await latestWebsocketProvider();

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

    const messageLog = await latestMessageLog();
    const provider = await latestWebsocketProvider();

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
