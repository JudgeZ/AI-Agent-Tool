import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

const createLocalStorage = () => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => (key in store ? store[key] : null)),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
    get length() {
      return Object.keys(store).length;
    }
  } satisfies Storage;
};

const mockRaf = () => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    })
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
};

describe('layout store', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', createLocalStorage());
    mockRaf();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('clamps sidebar widths when updating', async () => {
    const { layoutState, setLeftWidth, setRightWidth } = await import('../layout');

    setLeftWidth(10);
    setRightWidth(10_000);

    const state = get(layoutState);
    expect(state.leftWidth).toBeGreaterThanOrEqual(220);
    expect(state.rightWidth).toBeLessThanOrEqual(640);
  });

  it('sanitizes persisted layout values and boolean flags', async () => {
    const stored = {
      leftWidth: 1024,
      rightWidth: 10,
      terminalHeight: Number.NaN,
      terminalOpen: 'yes'
    } as unknown;
    const serialized = JSON.stringify(stored);
    (globalThis.localStorage as Storage).setItem('oss.ide.layout', serialized);

    const { layoutState } = await import('../layout');
    const state = get(layoutState);

    expect(state.leftWidth).toBe(520);
    expect(state.rightWidth).toBe(320);
    expect(state.terminalHeight).toBe(240);
    expect(state.terminalOpen).toBe(false);
  });

  it('clears corrupted persisted state and falls back to defaults', async () => {
    (globalThis.localStorage as Storage).setItem('oss.ide.layout', '{invalid json');

    const { layoutState } = await import('../layout');
    const state = get(layoutState);

    expect(state).toEqual({ leftWidth: 260, rightWidth: 380, terminalHeight: 240, terminalOpen: false });
    expect(globalThis.localStorage.removeItem).toHaveBeenCalledWith('oss.ide.layout');
  });

  it('persists updates via requestAnimationFrame batching', async () => {
    const { layoutState, setTerminalHeight } = await import('../layout');
    const storage = globalThis.localStorage as Storage;

    setTerminalHeight(300);
    layoutState.update((state) => state);

    await new Promise((resolve) => requestAnimationFrame(resolve));
    const updatedState = get(layoutState);

    expect(updatedState.terminalHeight).toBe(300);
    expect(globalThis.requestAnimationFrame).toHaveBeenCalled();
    expect(storage.setItem).toHaveBeenCalled();
  });

  it('skips persisting during initial hydration until state changes', async () => {
    const { setLeftWidth } = await import('../layout');
    const storage = globalThis.localStorage as Storage;

    expect(storage.setItem).not.toHaveBeenCalled();

    setLeftWidth(300);

    expect(storage.setItem).toHaveBeenCalled();
  });
});
