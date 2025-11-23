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

/**
 * Constrains a numeric value to lie within the inclusive range defined by `min` and `max`.
 *
 * @param value - The number to constrain
 * @param min - The lower bound of the range (inclusive)
 * @param max - The upper bound of the range (inclusive)
 * @returns `value` constrained to the inclusive range `[min, max]`
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Validate and constrain a numeric layout dimension, returning a fallback for invalid input.
 *
 * @param value - The candidate value to validate as a finite number
 * @param min - Inclusive minimum allowed value
 * @param max - Inclusive maximum allowed value
 * @param fallback - Value to return when `value` is not a finite number
 * @returns A number within `[min, max]` when `value` is finite, otherwise `fallback`
 */
function normalizeDimension(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
}

/**
 * Return the given value when it is a boolean; otherwise use the provided fallback.
 *
 * @param value - The value to validate as a boolean
 * @param fallback - The boolean to return when `value` is not a boolean
 * @returns `value` if it is a boolean, `fallback` otherwise
 */
function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Load the persisted layout state from localStorage, falling back to defaults when unavailable or invalid.
 *
 * @returns The hydrated LayoutState — stored values with dimensions clamped to their min/max and `terminalOpen` coerced to a boolean; returns `defaultState` if not running in a browser, if no stored state exists, or if the stored value is invalid or corrupted.
 */
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
  const hydratedState = readPersistedState();
  layoutStore.set(hydratedState);

  let rafId: number | null = null;
  let queuedState: LayoutState | null = null;
  let hydrating = true;
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

    if (hydrating) {
      hydrating = false;
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

/**
 * Update the persisted left panel width, ensuring the value is within the specified bounds.
 *
 * @param width - Desired left panel width in pixels
 * @param min - Minimum allowed width; defaults to `LEFT_MIN`
 * @param max - Maximum allowed width; defaults to `LEFT_MAX`
 */
export function setLeftWidth(width: number, min = LEFT_MIN, max = LEFT_MAX): void {
  layoutStore.update((state) => ({
    ...state,
    leftWidth: normalizeDimension(width, min, max, state.leftWidth)
  }));
}

/**
 * Update the persisted right panel width, clamped to the provided bounds.
 *
 * @param width - Desired right panel width in pixels
 * @param min - Minimum allowed width (defaults to `RIGHT_MIN`)
 * @param max - Maximum allowed width (defaults to `RIGHT_MAX`)
 */
export function setRightWidth(width: number, min = RIGHT_MIN, max = RIGHT_MAX): void {
  layoutStore.update((state) => ({
    ...state,
    rightWidth: normalizeDimension(width, min, max, state.rightWidth)
  }));
}

/**
 * Set the terminal panel height, normalized to the provided bounds.
 *
 * Normalizes `height` to the inclusive range `[min, max]` and updates the layout store;
 * if `height` is not a valid number, the current terminal height is retained.
 *
 * @param height - Desired terminal height in pixels
 * @param min - Minimum allowed terminal height (inclusive)
 * @param max - Maximum allowed terminal height (inclusive)
 */
export function setTerminalHeight(height: number, min = TERMINAL_MIN, max = TERMINAL_MAX): void {
  layoutStore.update((state) => ({
    ...state,
    terminalHeight: normalizeDimension(height, min, max, state.terminalHeight)
  }));
}

/**
 * Toggles the terminal's visibility in the layout store.
 */
export function toggleTerminal(): void {
  layoutStore.update((state) => ({ ...state, terminalOpen: !state.terminalOpen }));
}

/**
 * Set whether the terminal panel is open.
 *
 * @param open - `true` to open the terminal, `false` to close it. If `open` is not a boolean, the previous `terminalOpen` value is preserved.
 */
export function setTerminalOpen(open: boolean): void {
  layoutStore.update((state) => ({
    ...state,
    terminalOpen: sanitizeBoolean(open, state.terminalOpen)
  }));
}