<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import type { PageData } from './$types';

  export let data: PageData;

  const refresh = async () => {
    await invalidateAll();
  };
</script>

<section class="ops-panel" aria-labelledby="cases-heading">
  <div class="panel-header">
    <div>
      <p class="eyebrow">Operations</p>
      <h1 id="cases-heading">Cases</h1>
      <p class="muted">Track live automation incidents and attach artifacts for review.</p>
    </div>
    <button class="primary" aria-label="Create case">New Case</button>
  </div>

  {#if data.error}
    <div class="error-banner" role="status">
      <span>{data.error}</span>
      <button type="button" on:click={refresh}>Retry</button>
    </div>
  {/if}
  <div class="case-grid" role="list">
    {#each data.cases ?? [] as item (item.id ?? item.title)}
      <article class="case-card" role="listitem" aria-labelledby={`case-${item.id}`}>
        <header class="case-card__header">
          <div>
            <p class="eyebrow">{item.projectId}</p>
            <h2 id={`case-${item.id}`}>{item.title}</h2>
          </div>
          <span class={`status status-${item.status}`} aria-label={`Status ${item.status}`}>
            {item.status.replace('_', ' ')}
          </span>
        </header>

        <dl class="case-meta">
          <div>
            <dt>Case ID</dt>
            <dd>{item.id}</dd>
          </div>
          <div>
            <dt>Tasks</dt>
            <dd>{item.tasks}</dd>
          </div>
          <div>
            <dt>Artifacts</dt>
            <dd>{item.artifacts}</dd>
          </div>
        </dl>

        <div class="case-actions">
          <button aria-label={`Open ${item.title}`}>View</button>
          <button aria-label={`Attach artifact to ${item.title}`}>Attach artifact</button>
        </div>
      </article>
    {/each}
  </div>
</section>

<style>
  .ops-panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border: 1px solid rgba(148, 163, 184, 0.2);
    border-radius: 12px;
    background: rgba(12, 18, 38, 0.6);
  }

  .case-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 12px;
  }

  .case-card {
    padding: 16px;
    border-radius: 14px;
    background: rgba(16, 24, 48, 0.7);
    border: 1px solid rgba(148, 163, 184, 0.15);
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.25);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .case-card__header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px;
  }

  .eyebrow {
    text-transform: uppercase;
    font-size: 12px;
    letter-spacing: 1px;
    color: #94a3b8;
    margin: 0 0 4px;
  }

  h1, h2 {
    margin: 0;
  }

  .muted {
    color: #cbd5e1;
    margin: 4px 0 0;
  }

  .case-meta {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .case-meta dt {
    color: #94a3b8;
    font-size: 12px;
    margin-bottom: 4px;
  }

  .case-meta dd {
    margin: 0;
    font-weight: 600;
  }

  .status {
    padding: 6px 10px;
    border-radius: 999px;
    font-size: 12px;
    text-transform: capitalize;
    border: 1px solid rgba(148, 163, 184, 0.2);
  }

  .error-banner {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border: 1px solid rgba(239, 68, 68, 0.3);
    background: rgba(239, 68, 68, 0.08);
    color: #fecdd3;
    border-radius: 12px;
    margin-bottom: 12px;
  }

  .error-banner button {
    background: transparent;
    border-color: rgba(239, 68, 68, 0.4);
    color: #fecdd3;
  }

  .status-open {
    background: rgba(59, 130, 246, 0.15);
    color: #bfdbfe;
  }

  .status-in_progress {
    background: rgba(234, 179, 8, 0.15);
    color: #fef08a;
  }

  .status-closed {
    background: rgba(34, 197, 94, 0.15);
    color: #bbf7d0;
  }

  .case-actions {
    display: flex;
    gap: 8px;
  }

  button {
    background: rgba(59, 130, 246, 0.15);
    color: #e2e8f0;
    border: 1px solid rgba(59, 130, 246, 0.3);
    padding: 8px 12px;
    border-radius: 10px;
    cursor: pointer;
    font-weight: 600;
  }

  button.primary {
    background: linear-gradient(120deg, #3b82f6, #06b6d4);
    border-color: transparent;
    box-shadow: 0 8px 20px rgba(59, 130, 246, 0.35);
  }
</style>
