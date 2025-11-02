<script lang="ts">
  import type { PlanStep } from '$lib/stores/planTimeline';
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import DiffViewer from './DiffViewer.svelte';

  export let step: PlanStep;
  export let submitting: boolean;
  export let error: string | null;

  const dispatch = createEventDispatcher<{ approve: { rationale?: string }; reject: { rationale?: string } }>();
  let rationale = '';
  let modalElement: HTMLElement | null = null;
  let previouslyFocused: HTMLElement | null = null;

  type EgressRequest = { url: string; method?: string; reason?: string };

  function getFocusableElements(): HTMLElement[] {
    if (!modalElement) {
      return [];
    }
    const selectors = [
      'a[href]',
      'button:not([disabled])',
      'textarea:not([disabled])',
      'input:not([type="hidden"]):not([disabled])',
      'select:not([disabled])',
      '[tabindex]:not([tabindex="-1"])'
    ];
    const nodes = Array.from(modalElement.querySelectorAll<HTMLElement>(selectors.join(',')));
    return nodes.filter(node => !node.hasAttribute('disabled') && node.offsetParent !== null);
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Tab') {
      return;
    }
    const focusable = getFocusableElements();
    if (focusable.length === 0) {
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;

    if (event.shiftKey) {
      if (active === first || active === modalElement) {
        event.preventDefault();
        last.focus();
      }
      return;
    }

    if (active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  onMount(async () => {
    previouslyFocused = document.activeElement as HTMLElement | null;
    modalElement?.addEventListener('keydown', handleKeyDown, true);
    await tick();
    const focusable = getFocusableElements();
    (focusable[0] ?? modalElement)?.focus();
  });

  onDestroy(() => {
    modalElement?.removeEventListener('keydown', handleKeyDown, true);
    previouslyFocused?.focus?.();
  });

  $: diffVisible = step.capability.startsWith('repo.write') && Boolean(step.diff);
  $: egressRequests = extractEgress(step);
  $: egressVisible = step.capability.startsWith('network.egress') && egressRequests.length > 0;

  function extractEgress(target: PlanStep): EgressRequest[] {
    const output = target.latestOutput;
    if (!output) return [];
    const raw =
      (output.egress_requests ?? output.egressRequests ?? output.requests ?? output.destinations) as unknown;
    if (!Array.isArray(raw)) return [];
    const prepared = raw.map((entry): EgressRequest | null => {
      if (!entry || typeof entry !== 'object') return null;
      const url =
        typeof (entry as { url?: unknown }).url === 'string'
          ? (entry as { url: string }).url
          : typeof (entry as { host?: unknown }).host === 'string'
          ? (entry as { host: string }).host
          : undefined;
      if (!url) return null;
      const method = typeof (entry as { method?: unknown }).method === 'string' ? (entry as { method: string }).method : undefined;
      const reason = typeof (entry as { reason?: unknown }).reason === 'string' ? (entry as { reason: string }).reason : undefined;
      return { url, method, reason };
    });
    return prepared.filter((value): value is EgressRequest => value !== null);
  }

  const onApprove = () => {
    dispatch('approve', { rationale: rationale.trim() || undefined });
  };

  const onReject = () => {
    dispatch('reject', { rationale: rationale.trim() || undefined });
  };
</script>

<div class="modal__backdrop" role="presentation">
  <section
    class="modal"
    role="presentation"
  >
    <div
      class="modal__container"
      role="dialog"
      aria-modal="true"
      aria-labelledby="approval-title"
      tabindex="-1"
      bind:this={modalElement}
    >
      <header class="modal__header">
        <h2 id="approval-title">Approval required</h2>
        <p class="modal__subtitle">
          Step <strong>{step.action}</strong> requires confirmation before continuing.
        </p>
      </header>
      <dl class="modal__details">
        <div>
          <dt>Capability</dt>
          <dd>{step.capability}</dd>
        </div>
        <div>
          <dt>Current status</dt>
          <dd>{step.state.replace('_', ' ')}</dd>
        </div>
        {#if step.summary}
          <div>
            <dt>Summary</dt>
            <dd>{step.summary}</dd>
          </div>
        {/if}
      </dl>
      {#if error}
        <p class="modal__error">{error}</p>
      {/if}
      {#if diffVisible && step.diff}
        <section class="modal__section">
          <h3>Pending diff</h3>
          <DiffViewer diff={step.diff} />
        </section>
      {/if}
      {#if egressVisible}
        <section class="modal__section">
          <h3>Planned network requests</h3>
          <ul class="egress-list">
            {#each egressRequests as request}
              <li>
                <span class="egress-list__target">{request.url}</span>
                {#if request.method}
                  <span class="egress-list__method">{request.method}</span>
                {/if}
                {#if request.reason}
                  <span class="egress-list__reason">{request.reason}</span>
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      {/if}
      <label class="modal__rationale">
        <span>Rationale (optional)</span>
        <textarea
          rows="3"
          bind:value={rationale}
          placeholder="Leave a note about this decision"
          disabled={submitting}
        ></textarea>
      </label>
      <footer class="modal__actions">
        <button class="reject" on:click={onReject} disabled={submitting}>Reject</button>
        <button class="approve" on:click={onApprove} disabled={submitting}>
          {submitting ? 'Submitting…' : 'Approve'}
        </button>
      </footer>
    </div>
  </section>
</div>

<style>
  .modal__backdrop {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.65);
    display: grid;
    place-items: center;
    z-index: 20;
    backdrop-filter: blur(8px);
  }

  .modal__container {
    width: min(480px, 92vw);
    background: rgba(15, 23, 42, 0.95);
    border-radius: 1rem;
    padding: 1.5rem;
    border: 1px solid rgba(148, 163, 184, 0.4);
    box-shadow: 0 20px 55px rgba(15, 23, 42, 0.45);
    color: inherit;
    outline: none;
    display: block;
  }

  .modal__header h2 {
    margin: 0;
    font-size: 1.35rem;
  }

  .modal__subtitle {
    margin: 0.5rem 0 0;
    color: #cbd5f5;
  }

  .modal__details {
    margin: 1rem 0 1.5rem;
    display: grid;
    gap: 0.75rem;
  }

  dt {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #94a3b8;
  }

  dd {
    margin: 0.25rem 0 0;
    font-weight: 600;
  }

  .modal__section {
    margin: 1rem 0;
  }

  .modal__section h3 {
    margin: 0 0 0.5rem;
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #cbd5f5;
  }

  .modal__rationale {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin: 1.25rem 0;
    font-size: 0.85rem;
  }

  .modal__rationale textarea {
    background: rgba(15, 23, 42, 0.85);
    border: 1px solid rgba(148, 163, 184, 0.4);
    border-radius: 0.5rem;
    padding: 0.5rem 0.65rem;
    color: inherit;
    resize: vertical;
  }

  .modal__actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
  }

  button {
    padding: 0.55rem 1rem;
    border-radius: 0.5rem;
    border: none;
    font-weight: 600;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .approve {
    background: linear-gradient(135deg, #4ade80, #22d3ee);
    color: #0f172a;
  }

  .reject {
    background: rgba(248, 113, 113, 0.15);
    color: #fca5a5;
  }

  .modal__error {
    margin: 0 0 1rem;
    color: #fca5a5;
  }

  .egress-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.35rem;
  }

  .egress-list li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    font-size: 0.85rem;
  }

  .egress-list__target {
    font-family: 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',
      monospace;
  }

  .egress-list__method {
    text-transform: uppercase;
    font-size: 0.7rem;
    background: rgba(94, 234, 212, 0.15);
    color: #5eead4;
    padding: 0.2rem 0.4rem;
    border-radius: 999px;
  }

  .egress-list__reason {
    color: #cbd5f5;
  }
</style>
