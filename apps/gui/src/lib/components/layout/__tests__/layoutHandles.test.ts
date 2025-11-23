import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import ResizableSidebar from '../ResizableSidebar.svelte';
import TerminalPanel from '../TerminalPanel.svelte';

const noop = () => {};

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
});
