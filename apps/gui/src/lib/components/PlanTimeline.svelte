<script lang="ts">
  import { logger } from '$lib/logger';
  import { timeline } from '$lib/stores/planTimeline';
  import ApprovalModal from './ApprovalModal.svelte';
  import PlanStep from './PlanStep.svelte';
  import type { PlanStep as PlanStepType } from '$lib/stores/planTimeline';
  import { derived } from 'svelte/store';

  const timelineState = timeline;
  const awaitingApproval = derived(timelineState, ($state) => $state.awaitingApproval);
  const connection = derived(timelineState, ($state) => ({
    connected: $state.connected,
    error: $state.connectionError,
    planId: $state.planId,
    retrying: $state.retrying,
    retryAttempt: $state.retryAttempt,
    maxRetryAttempts: $state.maxRetryAttempts
  }));

  const submitDecision = async (decision: 'approve' | 'reject', rationale?: string) => {
    try {
      await timeline.submitApproval(decision, rationale);
    } catch (error) {
      logger.error('Failed to submit plan decision.', { error });
    }
  };
</script>

<section class="status">
  {#if $connection.planId}
    <span class:connected={$connection.connected} class="status__pill">
      {#if $connection.connected}
        Connected
      {:else if $connection.retrying}
        Reconnecting…{#if $connection.retryAttempt > 0} (attempt {$connection.retryAttempt} of {$connection.maxRetryAttempts}){/if}
      {:else}
        Connecting…
      {/if}
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
      <PlanStep {step} />
    {/each}
  </ul>
{/if}

{#if $awaitingApproval}
  <ApprovalModal
    submitting={$timelineState.approvalSubmitting}
    error={$timelineState.approvalError}
    step={$awaitingApproval as PlanStepType}
    on:approve={(event) => submitDecision('approve', event.detail?.rationale)}
    on:reject={(event) => submitDecision('reject', event.detail?.rationale)}
  />
{/if}

<style>
  /* Status bar styles - connection status and plan identification */
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

  /* Empty state */
  .empty {
    margin: 0;
    color: #94a3b8;
  }

  /* Timeline container - layout only, step rendering delegated to PlanStep */
  .timeline {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 0;
    margin: 0;
  }
</style>
