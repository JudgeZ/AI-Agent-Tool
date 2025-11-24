import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ResizableSidebar from '../ResizableSidebar.svelte';
import TerminalPanel from '../TerminalPanel.svelte';

const noop = () => {};

if (typeof PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;

    constructor(type: string, init?: MouseEventInit & { pointerId?: number }) {
      super(type, { bubbles: true, cancelable: true, ...init });
      this.pointerId = init?.pointerId ?? 0;
    }
  }

  // @ts-expect-error Polyfill for environments missing PointerEvent
  global.PointerEvent = PointerEventPolyfill;
}

const mockAnimationFrame = () => {
  const callbacks: FrameRequestCallback[] = [];
  const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    callbacks.push(cb);
    return callbacks.length;
  });
  const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

  const flushFrames = () => {
    while (callbacks.length) {
      callbacks.shift()?.(0);
    }
  };

  return { rafSpy, cancelSpy, flushFrames };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ResizableSidebar', () => {
  it('resizes with keyboard arrows', async () => {
    const onResize = vi.fn();
    const { getByRole } = render(ResizableSidebar, {
      props: { width: 260, minWidth: 200, maxWidth: 520, onResize, ariaLabel: 'Sidebar' }
    });

    const handle = getByRole('separator', { name: /resize handle/i });

    await fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith(272);

    await fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(260);
  });

  it('inverts keyboard deltas for the right sidebar orientation', async () => {
    const onResize = vi.fn();
    const { getByRole } = render(ResizableSidebar, {
      props: { side: 'right', width: 360, minWidth: 320, maxWidth: 640, onResize, ariaLabel: 'Sidebar' }
    });

    const handle = getByRole('separator', { name: /resize handle/i });

    await fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(372);

    await fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith(360);
  });

  it('resizes via pointer drag with bounds and cleans up listeners', async () => {
    const onResize = vi.fn();
    const { rafSpy, flushFrames } = mockAnimationFrame();
    const { getByRole } = render(ResizableSidebar, {
      props: { width: 320, minWidth: 280, maxWidth: 360, onResize, ariaLabel: 'Sidebar' }
    });

    const handle = getByRole('separator', { name: /resize handle/i }) as HTMLDivElement;
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();

    await fireEvent(handle, new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 5, clientX: 300 }));
    await fireEvent(handle, new PointerEvent('pointermove', { bubbles: true, pointerId: 5, clientX: 340 }));
    flushFrames();
    expect(onResize).toHaveBeenLastCalledWith(360);
    expect(handle.setPointerCapture).toHaveBeenCalledWith(5);

    await fireEvent(handle, new PointerEvent('pointermove', { bubbles: true, pointerId: 5, clientX: 1000 }));
    flushFrames();
    expect(onResize).toHaveBeenLastCalledWith(360);
    expect(rafSpy).toHaveBeenCalled();

    await fireEvent(handle, new PointerEvent('pointerup', { bubbles: true, pointerId: 5 }));
    expect(onResize).toHaveBeenLastCalledWith(360);
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(5);
  });
});

describe('TerminalPanel', () => {
  it('opens when using keyboard arrows while closed', async () => {
    const onToggle = vi.fn();
    const { getByRole } = render(TerminalPanel, {
      props: { open: false, height: 200, minHeight: 160, maxHeight: 520, onToggle, onResize: noop }
    });

    const handle = getByRole('separator', { name: /terminal resize handle/i });
    await fireEvent.keyDown(handle, { key: 'ArrowDown' });
    await fireEvent.keyDown(handle, { key: 'ArrowUp' });

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('resizes with keyboard arrows when open', async () => {
    const onResize = vi.fn();
    const { getByRole } = render(TerminalPanel, {
      props: { open: true, height: 240, minHeight: 160, maxHeight: 520, onResize, onToggle: noop }
    });

    const handle = getByRole('separator', { name: /terminal resize handle/i });

    await fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(onResize).toHaveBeenLastCalledWith(254);

    await fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(onResize).toHaveBeenLastCalledWith(240);
  });

  it('ignores pointer resizing while closed and clamps drag height when open', async () => {
    const onResize = vi.fn();
    const onToggle = vi.fn();
    const { rafSpy, flushFrames } = mockAnimationFrame();
    const { getByRole, rerender } = render(TerminalPanel, {
      props: { open: false, height: 220, minHeight: 180, maxHeight: 260, onResize, onToggle }
    });

    let handle = getByRole('separator', { name: /terminal resize handle/i }) as HTMLDivElement;
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();

    await fireEvent(handle, new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 11, clientY: 300 }));
    await fireEvent(handle, new PointerEvent('pointermove', { bubbles: true, pointerId: 11, clientY: 200 }));
    expect(onResize).not.toHaveBeenCalled();
    expect(handle.setPointerCapture).not.toHaveBeenCalled();

    await rerender({ open: true, height: 220, minHeight: 180, maxHeight: 260, onResize, onToggle });

    handle = getByRole('separator', { name: /terminal resize handle/i }) as HTMLDivElement;
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();

    await fireEvent(handle, new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 11, clientY: 300 }));
    await fireEvent(handle, new PointerEvent('pointermove', { bubbles: true, pointerId: 11, clientY: 50 }));
    flushFrames();
    expect(onResize).toHaveBeenLastCalledWith(260);
    expect(handle.setPointerCapture).toHaveBeenCalledWith(11);
    expect(rafSpy).toHaveBeenCalled();

    await fireEvent(handle, new PointerEvent('pointermove', { bubbles: true, pointerId: 11, clientY: 400 }));
    flushFrames();
    expect(onResize).toHaveBeenLastCalledWith(180);

    await fireEvent(handle, new PointerEvent('pointerup', { bubbles: true, pointerId: 11 }));
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(11);
  });
});
