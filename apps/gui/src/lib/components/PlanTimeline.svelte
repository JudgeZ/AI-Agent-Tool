<script lang="ts">
  import { timeline } from '$lib/stores/planTimeline';
  import ApprovalModal from './ApprovalModal.svelte';
  import DiffViewer from './DiffViewer.svelte';
  import type { PlanStep } from '$lib/stores/planTimeline';
  import { derived } from 'svelte/store';

  const timelineState = timeline;
  const awaitingApproval = derived(timelineState, ($state) => $state.awaitingApproval);
  const connection = derived(timelineState, ($state) => ({
    connected: $state.connected,
    error: $state.connectionError,
    planId: $state.planId
  }));

  const formatTime = (iso: string) => new Date(iso).toLocaleTimeString();

  type EgressDescriptor = { target: string; method?: string; reason?: string };

  const getEgressRequests = (step: PlanStep): EgressDescriptor[] => {
    const output = step.latestOutput;
    if (!output) return [];
    const candidates =
      (output.egress_requests ?? output.egressRequests ?? output.requests ?? output.destinations) as unknown;
    if (!Array.isArray(candidates)) {
      return [];
    }
    const results: EgressDescriptor[] = [];
    for (const entry of candidates) {
      if (!entry || typeof entry !== 'object') continue;
      const url =
        typeof (entry as { url?: unknown }).url === 'string'
          ? (entry as { url: string }).url
          : typeof (entry as { host?: unknown }).host === 'string'
          ? (entry as { host: string }).host
          : undefined;
      if (!url) continue;
      const method =
        typeof (entry as { method?: unknown }).method === 'string'
          ? (entry as { method: string }).method
          : undefined;
      const reason =
        typeof (entry as { reason?: unknown }).reason === 'string'
          ? (entry as { reason: string }).reason
          : undefined;
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

  const submitDecision = async (decision: 'approve' | 'reject', rationale?: string) => {
    try {
      await timeline.submitApproval(decision, rationale);
    } catch (error) {
      console.error(error);
    }
  };
</script>

<section class="status">
  {#if $connection.planId}
    <span class:connected={$connection.connected} class="status__pill">
      {$connection.connected ? 'Connected' : 'Connecting…'}
    </span>
    <span class="status__plan">Plan: {$connection.planId}</span>
  {:else}
    <span class="status__placeholder">Enter a plan ID to begin streaming events.</span>
  {/if}
  {#if $connection.error}
    <span class="status__error">{$connection.error}</span>
  {/if}
</section>

{#if $timelineState.steps.length === 0 && $connection.planId}
  <p class="empty">Waiting for orchestrator events…</p>
{:else if $timelineState.steps.length > 0}
  <ul class="timeline">
    {#each $timelineState.steps as step (step.id)}
      <li class={`timeline__item timeline__item--${step.state}`} data-testid={`step-${step.id}`}>
        <header class="timeline__header">
          <div class="timeline__meta">
            <h2>{step.action}</h2>
            <div class="timeline__details">
              <span class="capability-label">{step.capabilityLabel}</span>
              <span class={`capability capability--${step.capability.replace(/\./g, '-')}`}>
                {step.capability}
              </span>
              <span class="detail">tool: {step.tool}</span>
              <span class="detail">timeout: {step.timeoutSeconds}s</span>
              {#if step.approvalRequired}
                <span class="detail approval">approval required</span>
              {/if}
            </div>
            {#if step.labels.length > 0}
              <div class="labels">
                {#each step.labels as label}
                  <span class="label">{label}</span>
                {/each}
              </div>
            {/if}
          </div>
          <span class="step-state">{step.state.replace(/_/g, ' ')}</span>
        </header>
        {#if step.summary}
          <p class="summary">{step.summary}</p>
        {/if}
        {#if step.diff && step.capability.startsWith('repo.write')}
          <DiffViewer diff={step.diff} />
        {/if}
        {#if step.capability.startsWith('network.egress') && getEgressRequests(step).length > 0}
          <section class="egress">
            <h3>Requested destinations</h3>
            <ul>
              {#each getEgressRequests(step) as request}
                <li>
                  <span class="egress__target">{request.target}</span>
                  {#if request.method}
                    <span class="egress__method">{request.method}</span>
                  {/if}
                  {#if request.reason}
                    <span class="egress__reason">{request.reason}</span>
                  {/if}
                </li>
              {/each}
            </ul>
          </section>
        {/if}
        <ul class="history">
          {#each step.history as entry, index (entry.state + index)}
            <li>
              <span class="history__time">{formatTime(entry.at)}</span>
              <span class="history__state">{entry.state.replace(/_/g, ' ')}</span>
              {#if entry.summary}
                <span class="history__summary">{entry.summary}</span>
              {/if}
            </li>
          {/each}
        </ul>
      </li>
    {/each}
  </ul>
{/if}

{#if $awaitingApproval}
  <ApprovalModal
    submitting={$timelineState.approvalSubmitting}
    error={$timelineState.approvalError}
    step={$awaitingApproval as PlanStep}
    on:approve={(event) => submitDecision('approve', event.detail?.rationale)}
    on:reject={(event) => submitDecision('reject', event.detail?.rationale)}
  />
{/if}

<style>
  .status {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    padding: 0.75rem 1rem;
    border-radius: 0.75rem;
    border: 1px solid rgba(148, 163, 184, 0.2);
    background: rgba(15, 23, 42, 0.55);
  }

  .status__pill {
    padding: 0.35rem 0.75rem;
    border-radius: 999px;
    background: rgba(148, 163, 184, 0.25);
    text-transform: uppercase;
    font-size: 0.75rem;
    letter-spacing: 0.08em;
  }

  .status__pill.connected {
    background: rgba(34, 211, 238, 0.2);
    color: #22d3ee;
  }

  .status__plan {
    font-weight: 600;
  }

  .status__placeholder {
    color: #94a3b8;
  }

  .status__error {
    color: #f87171;
    font-weight: 500;
  }

  .empty {
    margin: 0;
    color: #94a3b8;
  }

  .timeline {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 0;
    margin: 0;
  }

  .timeline__item {
    border-radius: 1rem;
    padding: 1.25rem;
    border: 1px solid rgba(148, 163, 184, 0.25);
    background: rgba(15, 23, 42, 0.65);
    box-shadow: 0 20px 40px rgba(15, 23, 42, 0.35);
  }

  .timeline__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
  }

  .timeline__header h2 {
    margin: 0 0 0.25rem;
    font-size: 1.15rem;
  }

  .timeline__meta {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .timeline__details {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.85rem;
    color: #cbd5f5;
  }

  .capability {
    display: inline-block;
    padding: 0.25rem 0.5rem;
    border-radius: 0.5rem;
    background: rgba(59, 130, 246, 0.18);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .capability-label {
    font-weight: 600;
  }

  .capability--repo-write {
    background: rgba(244, 114, 182, 0.2);
    color: #f472b6;
  }

  .capability--network-egress {
    background: rgba(248, 113, 113, 0.18);
    color: #f87171;
  }

  .detail {
    background: rgba(148, 163, 184, 0.12);
    padding: 0.15rem 0.4rem;
    border-radius: 0.4rem;
    text-transform: lowercase;
  }

  .detail.approval {
    background: rgba(250, 204, 21, 0.2);
    color: #facc15;
  }

  .labels {
    display: flex;
    gap: 0.35rem;
    flex-wrap: wrap;
  }

  .label {
    font-size: 0.7rem;
    background: rgba(94, 234, 212, 0.15);
    color: #5eead4;
    padding: 0.2rem 0.45rem;
    border-radius: 999px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .step-state {
    padding: 0.25rem 0.65rem;
    border-radius: 999px;
    background: rgba(148, 163, 184, 0.25);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .summary {
    margin: 0.5rem 0 0;
    color: #cbd5f5;
  }

  .history {
    list-style: none;
    padding: 0;
    margin: 0.75rem 0 0;
    display: grid;
    gap: 0.25rem;
  }

  .history__time {
    font-size: 0.75rem;
    color: #94a3b8;
    min-width: 5.5rem;
  }

  .history li {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
  }

  .history__state {
    font-weight: 600;
    text-transform: capitalize;
  }

  .history__summary {
    color: #cbd5f5;
  }

  .egress {
    margin: 0.75rem 0 0;
    border: 1px solid rgba(148, 163, 184, 0.35);
    border-radius: 0.75rem;
    padding: 0.75rem;
    background: rgba(15, 23, 42, 0.65);
  }

  .egress h3 {
    margin: 0 0 0.5rem;
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #e2e8f0;
  }

  .egress ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 0.35rem;
  }

  .egress li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: baseline;
  }

  .egress__target {
    font-family: 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',
      monospace;
    font-size: 0.8rem;
  }

  .egress__method {
    text-transform: uppercase;
    font-size: 0.7rem;
    background: rgba(94, 234, 212, 0.15);
    color: #5eead4;
    padding: 0.2rem 0.4rem;
    border-radius: 999px;
  }

  .egress__reason {
    color: #cbd5f5;
    font-size: 0.75rem;
  }
</style>
