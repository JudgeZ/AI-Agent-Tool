import { browser } from '$app/environment';
import { writable } from 'svelte/store';

export interface LayoutState {
  leftWidth: number;
  rightWidth: number;
  terminalHeight: number;
  terminalOpen: boolean;
}

const LAYOUT_STORAGE_KEY = 'oss.ide.layout';

export const LEFT_MIN = 220;
export const LEFT_MAX = 520;
export const RIGHT_MIN = 320;
export const RIGHT_MAX = 640;
export const TERMINAL_MIN = 180;
export const TERMINAL_MAX = 520;

const defaultState: LayoutState = {
  leftWidth: 260,
  rightWidth: 380,
  terminalHeight: 240,
  terminalOpen: false
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeDimension(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
}

function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readPersistedState(): LayoutState {
  if (!browser) {
    return defaultState;
  }
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return defaultState;
    const parsed = JSON.parse(raw) as Partial<LayoutState>;
    return {
      ...defaultState,
      leftWidth: normalizeDimension(parsed.leftWidth, LEFT_MIN, LEFT_MAX, defaultState.leftWidth),
      rightWidth: normalizeDimension(parsed.rightWidth, RIGHT_MIN, RIGHT_MAX, defaultState.rightWidth),
      terminalHeight: normalizeDimension(
        parsed.terminalHeight,
        TERMINAL_MIN,
        TERMINAL_MAX,
        defaultState.terminalHeight
      ),
      terminalOpen: sanitizeBoolean(parsed.terminalOpen, defaultState.terminalOpen)
    } satisfies LayoutState;
  } catch (error) {
    console.warn('[layout] Failed to read persisted layout state', error);
    try {
      localStorage.removeItem(LAYOUT_STORAGE_KEY);
    } catch (cleanupError) {
      console.warn('[layout] Failed to clear corrupted layout state', cleanupError);
    }
    return defaultState;
  }
}

const layoutStore = writable<LayoutState>(defaultState);

if (browser) {
  layoutStore.set(readPersistedState());

  let rafId: number | null = null;
  let queuedState: LayoutState | null = null;
  let initialized = false;
  let unsubscribe: (() => void) | null = null;

  const persistState = () => {
    rafId = null;
    if (!queuedState) return;

    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(queuedState));
    } catch (error) {
      console.warn('[layout] Failed to persist layout state', error);
    }
  };

  unsubscribe = layoutStore.subscribe((state) => {
    queuedState = state;

    if (!initialized) {
      initialized = true;
      return;
    }

    if (rafId === null) {
      rafId = requestAnimationFrame(persistState);
    }
  });

  const teardown = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    unsubscribe?.();
  };

  if (import.meta.hot) {
    import.meta.hot.dispose(teardown);
  }
}

export const layoutState = layoutStore;

export function setLeftWidth(width: number, min = LEFT_MIN, max = LEFT_MAX): void {
  layoutStore.update((state) => ({
    ...state,
    leftWidth: normalizeDimension(width, min, max, state.leftWidth)
  }));
}

export function setRightWidth(width: number, min = RIGHT_MIN, max = RIGHT_MAX): void {
  layoutStore.update((state) => ({
    ...state,
    rightWidth: normalizeDimension(width, min, max, state.rightWidth)
  }));
}

export function setTerminalHeight(height: number, min = TERMINAL_MIN, max = TERMINAL_MAX): void {
  layoutStore.update((state) => ({
    ...state,
    terminalHeight: normalizeDimension(height, min, max, state.terminalHeight)
  }));
}

export function toggleTerminal(): void {
  layoutStore.update((state) => ({ ...state, terminalOpen: !state.terminalOpen }));
}

export function setTerminalOpen(open: boolean): void {
  layoutStore.update((state) => ({
    ...state,
    terminalOpen: sanitizeBoolean(open, state.terminalOpen)
  }));
}
