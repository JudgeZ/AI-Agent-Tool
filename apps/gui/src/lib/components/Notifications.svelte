<script lang="ts">
  import { notifications, dismiss, type Notification } from '$lib/stores/notifications';

  const levelLabels: Record<Notification['level'], string> = {
    info: 'Information',
    success: 'Success',
    error: 'Error'
  };
</script>

<div class="toast-region" aria-live="polite" aria-atomic="false">
  {#each $notifications as notification (notification.id)}
    <article class={`toast ${notification.level}`} role="status">
      <div class="toast__header">
        <span class="toast__level">{levelLabels[notification.level]}</span>
        <button class="toast__dismiss" aria-label={`Dismiss ${notification.level} notification`} on:click={() => dismiss(notification.id)}>
          ✕
        </button>
      </div>
      <p class="toast__message">{notification.message}</p>
    </article>
  {/each}
</div>

<style>
  .toast-region {
    position: fixed;
    top: 16px;
    right: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    z-index: 1000;
    pointer-events: none;
  }

  .toast {
    min-width: 280px;
    max-width: 360px;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid rgba(148, 163, 184, 0.2);
    background: rgba(15, 23, 42, 0.95);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    color: #e2e8f0;
    pointer-events: auto;
  }

  .toast__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }

  .toast__level {
    font-size: 0.85rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .toast__message {
    margin: 0;
    font-size: 0.95rem;
    line-height: 1.4;
  }

  .toast__dismiss {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 1rem;
    padding: 4px;
    border-radius: 6px;
  }

  .toast__dismiss:focus-visible {
    outline: 2px solid rgba(94, 234, 212, 0.7);
    outline-offset: 2px;
  }

  .toast.info {
    border-color: rgba(59, 130, 246, 0.35);
  }

  .toast.success {
    border-color: rgba(34, 197, 94, 0.35);
  }

  .toast.error {
    border-color: rgba(248, 113, 113, 0.4);
  }
</style>
