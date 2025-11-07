import { get, type Readable } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MessageListener = (event: MessageEvent) => void;

const authorizeUrlMock = vi.fn((redirectUri: string) =>
  `https://gateway.example.test/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`
);

vi.mock('$lib/config', () => ({
  sessionPath: '/auth/session',
  logoutPath: '/auth/logout',
  oidcAuthorizeUrl: authorizeUrlMock
}));

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface Global {
      window: Window;
      fetch: typeof fetch;
    }
  }
}

describe('session store', () => {
  const listeners = new Map<string, MessageListener[]>();
  const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
  let initializeSession: () => void;
  let fetchSession: () => Promise<void>;
  let login: () => void;
  let logout: () => Promise<void>;
  let session: Readable<unknown>;
  const flushAsync = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  function installWindowMocks(): void {
    listeners.clear();
    const addEventListener = vi.fn(<K extends keyof WindowEventMap>(
      type: K,
      listener: (this: Window, ev: WindowEventMap[K]) => unknown
    ) => {
      const existing = listeners.get(type) ?? [];
      listeners.set(type, [...existing, listener as MessageListener]);
    });

    const fakeWindow = {
      location: { origin: 'https://app.example.test' },
      addEventListener,
      removeEventListener: vi.fn(),
      open: vi.fn(),
      dispatchMessage: (data: unknown) => {
        const messageListeners = listeners.get('message');
        if (!messageListeners) return;
        const event = new MessageEvent('message', { data });
        for (const listener of messageListeners) {
          listener(event);
        }
      }
    } as unknown as Window & { dispatchMessage: (data: unknown) => void };

    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('fetch', fetchMock);
  }

  async function importSessionModule(): Promise<void> {
    const module = await import('../session');
    initializeSession = module.initializeSession;
    fetchSession = module.fetchSession;
    login = module.login;
    logout = module.logout;
    session = module.session;
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllGlobals();
    authorizeUrlMock.mockClear();
    fetchMock.mockReset();
    installWindowMocks();
    await importSessionModule();
  });

  it('initializes by installing listeners and loading the current session', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        session: {
          id: 'abc',
          subject: 'user',
          roles: [],
          scopes: [],
          issuedAt: 'now',
          expiresAt: 'later'
        }
      })
    } as Response);

    initializeSession();
    expect(window.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    await flushAsync();
    expect(fetchMock).toHaveBeenCalledWith('/auth/session', {
      method: 'GET',
      credentials: 'include'
    });
    const state = get(session as never) as Record<string, unknown>;
    expect(state.authenticated).toBe(true);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        session: {
          id: 'abc',
          subject: 'user',
          roles: [],
          scopes: [],
          issuedAt: 'now',
          expiresAt: 'later'
        }
      })
    } as Response);

    (window as typeof window & { dispatchMessage: (data: unknown) => void }).dispatchMessage({
      type: 'oidc:complete',
      status: 'success'
    });
    await flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('updates state with session info when fetchSession succeeds', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        session: {
          id: 'sess-1',
          subject: 'subject-1',
          roles: ['reader'],
          scopes: ['repo.read'],
          issuedAt: 'now',
          expiresAt: 'later'
        }
      })
    } as Response);

    await fetchSession();
    const state = get(session as never) as Record<string, unknown>;
    expect(state.authenticated).toBe(true);
    expect(state.info).toMatchObject({ id: 'sess-1', subject: 'subject-1' });
    expect(state.error).toBeNull();
  });

  it('captures errors when fetching the session fails', async () => {
    const failure = new Error('network down');
    fetchMock.mockRejectedValueOnce(failure);

    await fetchSession();
    const state = get(session as never) as Record<string, unknown>;
    expect(state.authenticated).toBe(false);
    expect(state.error).toBe('network down');
  });

  it('propagates popup blocked errors during login', () => {
    (window.open as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);

    login();
    const state = get(session as never) as Record<string, unknown>;
    expect(state.error).toBe('Popup blocked. Allow popups and try again.');
  });

  it('focuses the popup when login succeeds', () => {
    const focus = vi.fn();
    (window.open as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({ focus } as unknown as Window);

    login();
    expect(authorizeUrlMock).toHaveBeenCalledWith('https://app.example.test/auth/callback');
    expect(focus).toHaveBeenCalled();
    const state = get(session as never) as Record<string, unknown>;
    expect(state.error).toBeNull();
  });

  it('resets the session state when logout succeeds', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true } as Response);

    await logout();
    const state = get(session as never) as Record<string, unknown>;
    expect(state.authenticated).toBe(false);
    expect(state.info).toBeNull();
    expect(state.error).toBeNull();
  });

  it('captures errors when logout fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('logout failed'));

    await logout();
    const state = get(session as never) as Record<string, unknown>;
    expect(state.loading).toBe(false);
    expect(state.error).toBe('logout failed');
  });
});
