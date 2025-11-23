import { render, act, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/config', () => ({ gatewayBaseUrl: 'https://example.com' }));

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: { target: MockWebSocket }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;

  send = vi.fn();
  close = vi.fn((code?: number, reason?: string) => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  });

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({ target: this });
  }
}

declare global {
  // eslint-disable-next-line no-var
  var WebSocket: typeof MockWebSocket;
}

vi.mock('$lib/stores/session', async () => {
  const { writable: createWritable } = await import('svelte/store');
  const sessionStore = createWritable({ authenticated: true, info: { id: 'session-1' }, loading: false, error: null });
  return {
    session: {
      subscribe: sessionStore.subscribe,
    },
    sessionStore,
  };
});

import Terminal from '../Terminal.svelte';

describe('Terminal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    class MockResizeObserver {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    MockWebSocket.instances.splice(0, MockWebSocket.instances.length);
    const terminalModule = await import('@xterm/xterm');
    terminalModule.Terminal.instances.splice(0, terminalModule.Terminal.instances.length);
    const fitModule = await import('@xterm/addon-fit');
    fitModule.FitAddon.instances.splice(0, fitModule.FitAddon.instances.length);
    const { sessionStore } = await import('$lib/stores/session');
    sessionStore.set({ authenticated: true, info: { id: 'session-1' }, loading: false, error: null });
  });

  it('does not tear down an in-flight terminal connection when session updates with the same id', async () => {
    const { sessionStore } = await import('$lib/stores/session');
    const { unmount } = render(Terminal);

    expect(MockWebSocket.instances).toHaveLength(1);
    const [socket] = MockWebSocket.instances;
    expect(socket.readyState).toBe(MockWebSocket.CONNECTING);

    await act(() => {
      sessionStore.set({ authenticated: true, info: { id: 'session-1' }, loading: false, error: null });
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket.close).not.toHaveBeenCalled();

    socket.open();
    unmount();
  });

  it('does not automatically reconnect after a halted session with the same id', async () => {
    const { sessionStore } = await import('$lib/stores/session');
    render(Terminal);

    expect(MockWebSocket.instances).toHaveLength(1);
    const [socket] = MockWebSocket.instances;

    socket.open();
    socket.close(1008);

    await act(() => {
      sessionStore.set({ authenticated: true, info: { id: 'session-1' }, loading: false, error: null });
    });

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('keeps the terminal gated when the user is signed out', async () => {
    const { sessionStore } = await import('$lib/stores/session');
    await act(() => {
      sessionStore.set({ authenticated: false, info: null, loading: false, error: null });
    });

    render(Terminal);
    await act(() => Promise.resolve());

    expect(MockWebSocket.instances).toHaveLength(0);
    expect(screen.getByText('Sign in to start the terminal.')).toBeInTheDocument();
  });

  it('connects with the expected websocket url and sends a single resize payload', async () => {
    render(Terminal);
    await act(() => Promise.resolve());

    expect(MockWebSocket.instances).toHaveLength(1);
    const [socket] = MockWebSocket.instances;

    expect(socket.url).toBe('wss://example.com/sandbox/terminal?sessionId=session-1');

    socket.open();

    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({ type: 'resize', cols: 80, rows: 24 });

    window.dispatchEvent(new Event('resize'));
    await act(() => {});

    expect(socket.send).toHaveBeenCalledTimes(1);
  });

  it('streams terminal output, updates status counts, and halts after exit messages', async () => {
    render(Terminal);
    await act(() => Promise.resolve());
    const [socket] = MockWebSocket.instances;
    socket.open();
    const terminalModule = await import('@xterm/xterm');
    expect(terminalModule.Terminal.instances).toHaveLength(1);
    const terminal = terminalModule.Terminal.instances.at(-1) as unknown as {
      write: ReturnType<typeof vi.fn>;
      dataHandler: ((input: string) => void) | null;
    };

    await act(() => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'output', data: 'hello' }) });
    });
    expect(terminal.write).toHaveBeenCalledWith('hello');

    await act(() => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'status', status: 'ok', clients: 3 }) });
    });
    expect(screen.getByText('Clients connected: 3')).toBeInTheDocument();

    await act(() => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'exit', exitCode: 12 }) });
    });

    expect(screen.getByText('Session ended (code 12)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry terminal connection' })).toBeInTheDocument();

    vi.runAllTimers();
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('allows manual retries after a halted session to rebuild the websocket', async () => {
    render(Terminal);
    await act(() => Promise.resolve());
    const [initialSocket] = MockWebSocket.instances;
    initialSocket.open();

    await act(() => {
      initialSocket.onmessage?.({ data: JSON.stringify({ type: 'exit', exitCode: 0 }) });
    });
    await act(() => {
      initialSocket.close(1000);
    });

    const retryButton = screen.getByRole('button', { name: 'Retry terminal connection' });
    expect(MockWebSocket.instances).toHaveLength(1);

    await act(() => {
      retryButton.click();
    });

    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('schedules reconnection attempts after socket errors', async () => {
    render(Terminal);
    await act(() => Promise.resolve());
    const [socket] = MockWebSocket.instances;

    socket.onerror?.();
    await act(() => Promise.resolve());

    expect(screen.getByText(/Reconnecting in/)).toBeInTheDocument();
    socket.readyState = MockWebSocket.CLOSED;
    vi.runAllTimers();

    expect(MockWebSocket.instances.length).toBe(2);
  });

  it('halts reconnection on policy closures between 4000 and 4999', async () => {
    render(Terminal);
    await act(() => Promise.resolve());
    const [socket] = MockWebSocket.instances;
    socket.open();

    socket.onclose?.({ code: 4401, reason: 'forbidden' });
    await act(() => Promise.resolve());

    expect(screen.getByText('Terminal access denied. Please check your permissions.')).toBeInTheDocument();
    vi.runAllTimers();
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('halts reconnection when the server closes the websocket after a terminal exit', async () => {
    render(Terminal);
    await act(() => Promise.resolve());
    const [socket] = MockWebSocket.instances;
    socket.open();

    await act(() => {
      socket.onclose?.({ code: 1011, reason: 'terminal session ended' });
    });

    expect(screen.getByText(/Terminal session ended/i)).toBeInTheDocument();
    vi.runAllTimers();
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('disposes terminal resources on teardown', async () => {
    const { unmount } = render(Terminal);
    await act(() => Promise.resolve());

    const terminalModule = await import('@xterm/xterm');
    const fitModule = await import('@xterm/addon-fit');

    const terminal = terminalModule.Terminal.instances.at(-1)!;
    const fitAddon = fitModule.FitAddon.instances.at(-1)!;

    unmount();

    expect(terminal.dispose).toHaveBeenCalled();
    expect(fitAddon.dispose).toHaveBeenCalled();
  });

  it('forwards terminal input when the socket is open', async () => {
    render(Terminal);
    await act(() => Promise.resolve());
    const [socket] = MockWebSocket.instances;
    socket.open();

    const terminal = (await import('@xterm/xterm')).Terminal.instances.at(-1) as unknown as { dataHandler: ((input: string) => void) | null };
    terminal.dataHandler?.('ls -la');

    expect(socket.send.mock.calls.at(-1)).toEqual([JSON.stringify({ type: 'input', data: 'ls -la' })]);
  });
});
