import { writable } from 'svelte/store';
import {
  logoutPath,
  oidcAuthorizeUrl,
  sessionPath
} from '$lib/config';

export interface SessionInfo {
  id: string;
  subject: string;
  email?: string | null;
  name?: string | null;
  tenantId?: string | null;
  roles: string[];
  scopes: string[];
  issuedAt: string;
  expiresAt: string;
}

export interface SessionState {
  loading: boolean;
  authenticated: boolean;
  info: SessionInfo | null;
  error: string | null;
}

const initialState: SessionState = {
  loading: false,
  authenticated: false,
  info: null,
  error: null
};

const sessionStore = writable<SessionState>({ ...initialState, loading: true });

let messageHandler: ((event: MessageEvent) => void) | null = null;

function installMessageListener(): void {
  if (typeof window === 'undefined' || messageHandler) {
    return;
  }
  messageHandler = (event: MessageEvent) => {
    if (!event?.data || typeof event.data !== 'object') {
      return;
    }
    const payload = event.data as { type?: string; status?: string; error?: string | null };
    if (payload.type !== 'oidc:complete') {
      return;
    }
    if (payload.status === 'success') {
      void fetchSession();
    } else {
      sessionStore.update((state) => ({ ...state, error: payload.error ?? 'Login was cancelled' }));
    }
  };
  window.addEventListener('message', messageHandler);
}

export async function fetchSession(): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }
  sessionStore.update((state) => ({ ...state, loading: true, error: null }));
  try {
    const response = await fetch(sessionPath, {
      method: 'GET',
      credentials: 'include'
    });
    if (!response.ok) {
      sessionStore.set({ ...initialState, loading: false });
      return;
    }
    const payload = (await response.json()) as { session?: SessionInfo };
    if (!payload.session) {
      sessionStore.set({ ...initialState, loading: false });
      return;
    }
    sessionStore.set({
      loading: false,
      authenticated: true,
      info: payload.session,
      error: null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load session';
    sessionStore.set({ ...initialState, loading: false, error: message });
  }
}

export function initializeSession(): void {
  if (typeof window === 'undefined') {
    return;
  }
  installMessageListener();
  void fetchSession();
}

export function login(): void {
  if (typeof window === 'undefined') {
    return;
  }
  installMessageListener();
  const redirectUri = new URL('/auth/callback', window.location.origin).toString();
  const authorizeUrl = oidcAuthorizeUrl(redirectUri);
  const popup = window.open(
    authorizeUrl,
    'oidc-login',
    'width=520,height=640,menubar=no,toolbar=no,status=no'
  );
  if (!popup) {
    sessionStore.update((state) => ({ ...state, error: 'Popup blocked. Allow popups and try again.' }));
  } else {
    popup.focus();
  }
}

export async function logout(): Promise<void> {
  sessionStore.update((state) => ({ ...state, loading: true, error: null }));
  try {
    await fetch(logoutPath, {
      method: 'POST',
      credentials: 'include'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to logout';
    sessionStore.update((state) => ({ ...state, loading: false, error: message }));
    return;
  }
  sessionStore.set({ ...initialState, loading: false });
}

export const session = {
  subscribe: sessionStore.subscribe,
  initialize: initializeSession,
  login,
  logout
};
