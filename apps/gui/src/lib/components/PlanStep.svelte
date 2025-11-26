<script lang="ts">
  import type { PlanStep } from '$lib/stores/planTimeline';
  import DiffViewer from './DiffViewer.svelte';

  /** The step data to render */
  export let step: PlanStep;

  /** Format ISO timestamp to locale time string */
  const formatTime = (iso: string) => new Date(iso).toLocaleTimeString();

  /** Descriptor for egress requests */
  type EgressDescriptor = { target: string; method?: string; reason?: string };

  /**
   * Extract egress request descriptors from step output.
   * Handles various output formats that may contain egress information.
   */
  const getEgressRequests = (stepData: PlanStep): EgressDescriptor[] => {
    const output = stepData.latestOutput;
    if (!output) return [];

    const candidates =
      (output.egress_requests ?? output.egressRequests ?? output.requests ?? output.destinations) as unknown;

    if (!Array.isArray(candidates)) {
      return [];
    }

    const results: EgressDescriptor[] = [];
    for (const entry of candidates) {
      if (!entry || typeof entry !== 'object') continue;

      // Cast once to simplify property access
      const record = entry as Record<string, unknown>;

      const url =
        typeof record.url === 'string'
          ? record.url
          : typeof record.host === 'string'
          ? record.host
          : undefined;

      if (!url) continue;

      const method = typeof record.method === 'string' ? record.method : undefined;
      const reason = typeof record.reason === 'string' ? record.reason : undefined;

      const descriptor: EgressDescriptor = { target: url };
      if (method) {
        descriptor.method = method;
      }
      if (reason) {
        descriptor.reason = reason;
      }
      results.push(descriptor);
    }
    return results;
  };

  // Reactive computed values
  $: egressRequests = getEgressRequests(step);
  $: showDiff = step.diff && step.capability.startsWith('repo.write');
  $: showEgress = step.capability.startsWith('network.egress') && egressRequests.length > 0;
</script>

<li class={`step step--${step.state}`} data-testid={`step-${step.id}`}>
  <header class="step__header">
    <div class="step__meta">
      <h2 class="step__action">{step.action}</h2>
      <div class="step__details">
        <span class="step__capability-label">{step.capabilityLabel}</span>
        <span class={`step__capability step__capability--${step.capability.replace(/\./g, '-')}`}>
          {step.capability}
        </span>
        <span class="step__detail">tool: {step.tool}</span>
        <span class="step__detail">timeout: {step.timeoutSeconds}s</span>
        {#if step.approvalRequired}
          <span class="step__detail step__detail--approval">approval required</span>
        {/if}
      </div>
      {#if step.labels.length > 0}
        <div class="step__labels">
          {#each step.labels as label (label)}
            <span class="step__label">{label}</span>
          {/each}
        </div>
      {/if}
    </div>
    <span class="step__state">{step.state.replace(/_/g, ' ')}</span>
  </header>

  {#if step.summary}
    <p class="step__summary">{step.summary}</p>
  {/if}

  {#if showDiff && step.diff}
    <DiffViewer diff={step.diff} />
  {/if}

  {#if showEgress}
    <section class="step__egress">
      <h3>Requested destinations</h3>
      <ul>
        {#each egressRequests as request, idx (`${request.target}-${idx}`)}
          <li>
            <span class="step__egress-target">{request.target}</span>
            {#if request.method}
              <span class="step__egress-method">{request.method}</span>
            {/if}
            {#if request.reason}
              <span class="step__egress-reason">{request.reason}</span>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <ul class="step__history">
    {#each step.history as entry, idx (`${entry.at}-${idx}`)}
      <li>
        <span class="step__history-time">{formatTime(entry.at)}</span>
        <span class="step__history-state">{entry.state.replace(/_/g, ' ')}</span>
        {#if entry.summary}
          <span class="step__history-summary">{entry.summary}</span>
        {/if}
      </li>
    {/each}
  </ul>
</li>

<style>
  .step {
    border-radius: 1rem;
    padding: 1.25rem;
    border: 1px solid rgba(148, 163, 184, 0.25);
    background: rgba(15, 23, 42, 0.65);
    box-shadow: 0 20px 40px rgba(15, 23, 42, 0.35);
  }

  .step__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
  }

  .step__action {
    margin: 0 0 0.25rem;
    font-size: 1.15rem;
  }

  .step__meta {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .step__details {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.85rem;
    color: #cbd5f5;
  }

  .step__capability {
    display: inline-block;
    padding: 0.25rem 0.5rem;
    border-radius: 0.5rem;
    background: rgba(59, 130, 246, 0.18);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .step__capability-label {
    font-weight: 600;
  }

  .step__capability--repo-write {
    background: rgba(244, 114, 182, 0.2);
    color: #f472b6;
  }

  .step__capability--network-egress {
    background: rgba(248, 113, 113, 0.18);
    color: #f87171;
  }

  .step__detail {
    background: rgba(148, 163, 184, 0.12);
    padding: 0.15rem 0.4rem;
    border-radius: 0.4rem;
    text-transform: lowercase;
  }

  .step__detail--approval {
    background: rgba(250, 204, 21, 0.2);
    color: #facc15;
  }

  .step__labels {
    display: flex;
    gap: 0.35rem;
    flex-wrap: wrap;
  }

  .step__label {
    font-size: 0.7rem;
    background: rgba(94, 234, 212, 0.15);
    color: #5eead4;
    padding: 0.2rem 0.45rem;
    border-radius: 999px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .step__state {
    padding: 0.25rem 0.65rem;
    border-radius: 999px;
    background: rgba(148, 163, 184, 0.25);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .step__summary {
    margin: 0.5rem 0 0;
    color: #cbd5f5;
  }

  .step__history {
    list-style: none;
    padding: 0;
    margin: 0.75rem 0 0;
    display: grid;
    gap: 0.25rem;
  }

  .step__history-time {
    font-size: 0.75rem;
    color: #94a3b8;
    min-width: 5.5rem;
  }

  .step__history li {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
  }

  .step__history-state {
    font-weight: 600;
    text-transform: capitalize;
  }

  .step__history-summary {
    color: #cbd5f5;
  }

  .step__egress {
    margin: 0.75rem 0 0;
    border: 1px solid rgba(148, 163, 184, 0.35);
    border-radius: 0.75rem;
    padding: 0.75rem;
    background: rgba(15, 23, 42, 0.65);
  }

  .step__egress h3 {
    margin: 0 0 0.5rem;
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #e2e8f0;
  }

  .step__egress ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 0.35rem;
  }

  .step__egress li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: baseline;
  }

  .step__egress-target {
    font-family: 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',
      monospace;
    font-size: 0.8rem;
  }

  .step__egress-method {
    text-transform: uppercase;
    font-size: 0.7rem;
    background: rgba(94, 234, 212, 0.15);
    color: #5eead4;
    padding: 0.2rem 0.4rem;
    border-radius: 999px;
  }

  .step__egress-reason {
    color: #cbd5f5;
    font-size: 0.75rem;
  }
</style>
