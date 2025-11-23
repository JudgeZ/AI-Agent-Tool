<script lang="ts">
  import { onDestroy } from 'svelte';
  import { LEFT_MAX, LEFT_MIN } from '$lib/stores/layout';

  export let side: 'left' | 'right' = 'left';
  export let width = 260;
  export let minWidth = LEFT_MIN;
  export let maxWidth = LEFT_MAX;
  export let ariaLabel = 'Sidebar';
  export let onResize: (value: number) => void = () => {};

  const step = 12;

  let startX = 0;
  let startWidth = width;
  let resizing = false;

  let pendingWidth = width;
  let rafId: number | null = null;
  let pointerId: number | null = null;
  let handleEl: HTMLDivElement | null = null;
  let dragSide: 'left' | 'right' = side;

  $: pendingWidth = width;

  const flushResize = () => {
    rafId = null;
    onResize(pendingWidth);
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    resizing = true;
    pointerId = event.pointerId;
    dragSide = side;
    startX = event.clientX;
    startWidth = width;
    pendingWidth = startWidth;
    handleEl?.setPointerCapture(pointerId);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (!resizing) return;
    const delta = dragSide === 'left' ? event.clientX - startX : startX - event.clientX;
    pendingWidth = Math.min(Math.max(startWidth + delta, minWidth), maxWidth);

    if (rafId === null) {
      rafId = requestAnimationFrame(flushResize);
    }
  };

  const handlePointerUp = () => {
    resizing = false;
    onResize(pendingWidth);
    teardownListeners();
  };

  const teardownListeners = () => {
    if (pointerId !== null) {
      handleEl?.releasePointerCapture(pointerId);
      pointerId = null;
    }
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    window.removeEventListener('pointercancel', handlePointerUp);
  };

  const handleKeyboardResize = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

    const movement = event.key === 'ArrowLeft' ? -step : step;
    const delta = side === 'right' ? -movement : movement;
    const base = pendingWidth ?? width;
    const next = Math.min(Math.max(base + delta, minWidth), maxWidth);
    pendingWidth = next;
    onResize(next);
    event.preventDefault();
  };

  onDestroy(teardownListeners);
</script>

<aside
  class={`resizable-sidebar ${side === 'right' ? 'right' : 'left'}`}
  style={`width: ${width}px; min-width: ${minWidth}px; max-width: ${maxWidth}px;`}
  aria-label={ariaLabel}
>
  <div class="surface">
    <slot />
  </div>
  <!-- svelte-ignore a11y-no-noninteractive-tabindex -->
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div
    class={`resize-handle ${resizing ? 'active' : ''}`}
    role="separator"
    aria-orientation="vertical"
    aria-label={`${ariaLabel} resize handle`}
    aria-valuemin={minWidth}
    aria-valuemax={maxWidth}
    aria-valuenow={width}
    tabindex="0"
    bind:this={handleEl}
    on:pointerdown|preventDefault={handlePointerDown}
    on:keydown={handleKeyboardResize}
  ></div>
</aside>

<style>
  .resizable-sidebar {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    position: relative;
    background: linear-gradient(145deg, rgba(15, 23, 42, 0.9), rgba(30, 41, 59, 0.85));
    border: 1px solid rgba(148, 163, 184, 0.1);
    border-radius: 14px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
  }

  .surface {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0.75rem;
    backdrop-filter: blur(6px);
  }

  .resize-handle {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 14px;
    cursor: col-resize;
    touch-action: none;
    background: linear-gradient(
      to right,
      transparent 35%,
      rgba(96, 165, 250, 0.12),
      rgba(14, 165, 233, 0.25),
      rgba(96, 165, 250, 0.12),
      transparent 65%
    );
    opacity: 0;
    transition: opacity 150ms ease-in-out, transform 180ms ease;
  }

  .resizable-sidebar.left .resize-handle {
    right: -7px;
  }

  .resizable-sidebar.right .resize-handle {
    left: -7px;
  }

  .resizable-sidebar:hover .resize-handle,
  .resize-handle.active {
    opacity: 1;
    transform: scaleX(1.05);
  }

  .resize-handle:focus-visible {
    opacity: 1;
    outline: 2px solid rgba(96, 165, 250, 0.9);
    outline-offset: 2px;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.3);
  }
</style>
