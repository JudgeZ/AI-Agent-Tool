<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import type { PageData } from './$types';

  export let data: PageData;

  const refresh = async () => {
    await invalidateAll();
  };
</script>

<section class="ops-panel" aria-labelledby="workflows-heading">
  <div class="panel-header">
    <div>
      <p class="eyebrow">Operations</p>
      <h1 id="workflows-heading">Workflows</h1>
      <p class="muted">Inspect automation runs across plans and approvals.</p>
    </div>
  </div>

  {#if data.error}
    <div class="error-banner" role="status">
      <span>{data.error}</span>
      <button type="button" on:click={refresh}>Retry</button>
    </div>
  {/if}

  <div class="workflow-list" role="table" aria-label="Workflow list">
    <div class="workflow-row header" role="row">
      <div role="columnheader">Workflow</div>
      <div role="columnheader">Status</div>
      <div role="columnheader">Case</div>
      <div role="columnheader">Steps</div>
      <div role="columnheader">Approvals</div>
      <div role="columnheader" class="actions">Actions</div>
    </div>

    {#each data.workflows ?? [] as wf (wf.id ?? wf.name)}
      <div class="workflow-row" role="row">
        <div role="cell">
          <p class="eyebrow">{wf.id}</p>
          <div class="name">{wf.name ?? wf.workflow ?? 'Workflow'}</div>
        </div>
        <div role="cell">
          <span class={`pill status-${wf.status}`}>{wf.status ?? 'unknown'}</span>
        </div>
        <div role="cell">{wf.caseId ?? '—'}</div>
        <div role="cell">{wf.steps ?? wf.nodes?.length ?? '—'}</div>
        <div role="cell">{wf.approvals ?? (Array.isArray(wf.nodes) ? wf.nodes.filter((n) => n.type === 'approval').length : '—')}</div>
        <div role="cell" class="actions">
          <button aria-label={`Inspect ${wf.name}`}>Inspect</button>
        </div>
      </div>
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

  .workflow-list {
    display: grid;
    gap: 8px;
  }

  .workflow-row {
    display: grid;
    grid-template-columns: 2.5fr 1fr 1fr 0.6fr 0.8fr 1fr;
    gap: 12px;
    align-items: center;
    padding: 12px 14px;
    border-radius: 12px;
    background: rgba(16, 24, 48, 0.7);
    border: 1px solid rgba(148, 163, 184, 0.15);
  }

  .workflow-row.header {
    background: transparent;
    border: none;
    color: #94a3b8;
    font-weight: 700;
    text-transform: uppercase;
    font-size: 12px;
    letter-spacing: 0.8px;
  }

  .eyebrow {
    text-transform: uppercase;
    font-size: 12px;
    letter-spacing: 1px;
    color: #94a3b8;
    margin: 0;
  }

  .muted {
    color: #cbd5e1;
    margin: 4px 0 0;
  }

  .name {
    font-weight: 700;
  }

  .pill {
    display: inline-flex;
    align-items: center;
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

  .status-running {
    background: rgba(59, 130, 246, 0.15);
    color: #bfdbfe;
  }

  .status-completed {
    background: rgba(34, 197, 94, 0.15);
    color: #bbf7d0;
  }

  .status-waiting {
    background: rgba(234, 179, 8, 0.15);
    color: #fef08a;
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

  .actions {
    text-align: right;
  }
</style>
