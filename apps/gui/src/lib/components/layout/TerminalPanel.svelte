<script lang="ts">
  import { onDestroy } from 'svelte';

  export let open = false;
  export let height = 240;
  export let minHeight = 160;
  export let maxHeight = 520;
  export let onResize: (value: number) => void = () => {};
  export let onToggle: () => void = () => {};

  const step = 14;

  let startY = 0;
  let startHeight = height;
  let resizing = false;

  let pendingHeight = height;
  let rafId: number | null = null;
  let pointerId: number | null = null;
  let handleEl: HTMLDivElement | null = null;

  $: pendingHeight = height;

  const flushResize = () => {
    rafId = null;
    onResize(pendingHeight);
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (!open || event.button !== 0) return;
    resizing = true;
    pointerId = event.pointerId;
    startY = event.clientY;
    startHeight = height;
    pendingHeight = startHeight;
    handleEl?.setPointerCapture(pointerId);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
    window.addEventListener('pointercancel', handlePointerUp, { once: true });
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (!resizing) return;
    const delta = startY - event.clientY;
    pendingHeight = Math.min(Math.max(startHeight + delta, minHeight), maxHeight);

    if (rafId === null) {
      rafId = requestAnimationFrame(flushResize);
    }
  };

  const handlePointerUp = () => {
    resizing = false;
    onResize(pendingHeight);
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
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;

    if (!open) {
      onToggle();
      event.preventDefault();
      return;
    }

    const delta = event.key === 'ArrowUp' ? step : -step;
    const base = pendingHeight ?? height;
    const next = Math.min(Math.max(base + delta, minHeight), maxHeight);
    pendingHeight = next;
    onResize(next);
    event.preventDefault();
  };

  onDestroy(teardownListeners);
</script>

<section
  class={`terminal-panel ${open ? 'open' : 'closed'}`}
  style={`height: ${open ? height : 40}px;`}
  aria-label="Terminal"
>
  <!-- svelte-ignore a11y-no-noninteractive-tabindex -->
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div
    class="drag-region"
    role="separator"
    aria-orientation="horizontal"
    aria-label="Terminal resize handle"
    aria-valuemin={minHeight}
    aria-valuemax={maxHeight}
    aria-valuenow={open ? height : minHeight}
    tabindex="0"
    bind:this={handleEl}
    on:pointerdown|preventDefault={handlePointerDown}
    on:keydown={handleKeyboardResize}
  >
    <div class={`handle ${resizing ? 'active' : ''}`}></div>
  </div>
  <header class="terminal-header">
    <div class="title">
      <span class="pulse" aria-hidden="true"></span>
      <span>Terminal</span>
    </div>
    <button class="toggle" type="button" on:click={onToggle} aria-expanded={open}>
      {open ? 'Hide' : 'Show'}
    </button>
  </header>
  {#if open}
    <div class="terminal-body">
      <slot />
    </div>
  {/if}
</section>

<style>
  .terminal-panel {
    background: linear-gradient(180deg, rgba(15, 23, 42, 0.94), rgba(10, 12, 24, 0.98));
    border: 1px solid rgba(148, 163, 184, 0.14);
    border-radius: 16px 16px 12px 12px;
    color: #e2e8f0;
    display: flex;
    flex-direction: column;
    transition: height 180ms ease;
    min-height: 40px;
    box-shadow: 0 -12px 60px rgba(0, 0, 0, 0.28);
    overflow: hidden;
  }

  .terminal-panel.closed {
    overflow: hidden;
  }

  .terminal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 0.85rem;
    background: linear-gradient(90deg, rgba(30, 41, 59, 0.82), rgba(15, 23, 42, 0.78));
    border-top: 1px solid rgba(148, 163, 184, 0.18);
    backdrop-filter: blur(8px);
  }

  .title {
    font-size: 0.95rem;
    font-weight: 700;
    display: inline-flex;
    gap: 0.4rem;
    align-items: center;
    letter-spacing: 0.01em;
  }

  .pulse {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: radial-gradient(circle at 30% 30%, #93c5fd, #0ea5e9 60%, rgba(14, 165, 233, 0));
    box-shadow: 0 0 16px rgba(14, 165, 233, 0.7);
    animation: breathe 2.8s ease-in-out infinite;
  }

  .toggle {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.35), rgba(45, 212, 191, 0.35));
    border: 1px solid rgba(94, 234, 212, 0.55);
    color: #e0f2fe;
    padding: 0.35rem 0.9rem;
    border-radius: 10px;
    cursor: pointer;
    font-weight: 600;
    transition: transform 160ms ease, box-shadow 160ms ease, filter 160ms ease;
    box-shadow: 0 10px 30px rgba(45, 212, 191, 0.25);
  }

  .toggle:hover {
    filter: brightness(1.08);
    transform: translateY(-1px);
    box-shadow: 0 14px 36px rgba(14, 165, 233, 0.32);
  }

  .drag-region {
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 6px 0;
    cursor: row-resize;
    touch-action: none;
    background: linear-gradient(to bottom, rgba(59, 130, 246, 0.1), rgba(15, 23, 42, 0));
  }

  .drag-region:focus-visible {
    outline: 2px solid rgba(94, 234, 212, 0.7);
    outline-offset: 2px;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
  }

  .handle {
    width: 70px;
    height: 7px;
    border-radius: 999px;
    background: linear-gradient(90deg, rgba(96, 165, 250, 0.55), rgba(14, 165, 233, 0.55));
    transition: background 120ms ease, box-shadow 160ms ease;
    box-shadow: 0 6px 20px rgba(14, 165, 233, 0.35);
  }

  .handle.active,
  .drag-region:hover .handle {
    background: linear-gradient(90deg, rgba(94, 234, 212, 0.85), rgba(59, 130, 246, 0.9));
    box-shadow: 0 10px 26px rgba(59, 130, 246, 0.45);
  }

  .terminal-body {
    flex: 1;
    overflow: auto;
    padding: 0.9rem;
    background: radial-gradient(circle at 20% 20%, rgba(59, 130, 246, 0.08), rgba(15, 23, 42, 0.96));
    border-top: 1px solid rgba(148, 163, 184, 0.08);
  }

  @keyframes breathe {
    0%,
    100% {
      transform: scale(1);
      opacity: 0.85;
    }
    50% {
      transform: scale(1.12);
      opacity: 1;
    }
  }
</style>
