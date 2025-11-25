<script lang="ts">
  import { onMount } from 'svelte';

  type WorkflowRecord = {
    id: string;
    name: string;
    tenantId?: string;
    projectId?: string;
    nodes?: Array<{ id: string; type: string; name: string }>;
    updatedAt?: string;
  };

  let workflows: WorkflowRecord[] = [];
  let loading = true;
  let error: string | null = null;

  async function loadWorkflows() {
    loading = true;
    error = null;
    try {
      const response = await fetch('/workflows');
      if (!response.ok) {
        throw new Error(`Failed to fetch workflows (${response.status})`);
      }
      const payload = await response.json();
      workflows = payload.workflows ?? [];
    } catch (err) {
      error = err instanceof Error ? err.message : 'Unable to load workflows';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void loadWorkflows();
  });
</script>

<section class="ops-section">
  <header class="ops-header">
    <div>
      <p class="eyebrow">Operations</p>
      <h1>Workflows</h1>
      <p class="subtitle">Inspect running and historical plan executions.</p>
    </div>
    <button class="ghost" on:click={loadWorkflows}>Refresh</button>
  </header>

  {#if loading}
    <div class="placeholder">Loading workflows…</div>
  {:else if error}
    <div class="error">{error}</div>
  {:else if workflows.length === 0}
    <div class="placeholder">No workflows registered yet.</div>
  {:else}
    <div class="grid">
      {#each workflows as wf}
        <article class="card">
          <header>
            <div>
              <p class="eyebrow">{wf.projectId ?? 'Project N/A'}</p>
              <h2>{wf.name}</h2>
            </div>
            <span class="pill">{wf.nodes?.length ?? 0} steps</span>
          </header>
          <ul>
            {#if wf.nodes && wf.nodes.length > 0}
              {#each wf.nodes as node}
                <li>
                  <span class={`badge ${node.type.toLowerCase()}`}>{node.type}</span>
                  <span class="node-name">{node.name}</span>
                </li>
              {/each}
            {:else}
              <li class="muted">No node details captured.</li>
            {/if}
          </ul>
          <footer>
            <span class="mono">{wf.id}</span>
            <span>{wf.updatedAt ? new Date(wf.updatedAt).toLocaleString() : '—'}</span>
          </footer>
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  .ops-section {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .ops-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 0.75rem;
    color: #94a3b8;
    margin: 0;
  }

  h1 {
    margin: 4px 0;
    font-size: 1.5rem;
  }

  h2 {
    margin: 4px 0 0;
    font-size: 1.1rem;
  }

  .subtitle {
    margin: 0;
    color: #cbd5f5;
  }

  .ghost {
    border: 1px solid rgba(148, 163, 184, 0.3);
    background: transparent;
    color: #cbd5f5;
    padding: 10px 14px;
    border-radius: 10px;
    cursor: pointer;
  }

  .ghost:hover,
  .ghost:focus-visible {
    border-color: rgba(148, 163, 184, 0.6);
    outline: none;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 12px;
  }

  .card {
    border: 1px solid rgba(148, 163, 184, 0.2);
    background: rgba(15, 23, 42, 0.6);
    border-radius: 14px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
  }

  .card header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .pill {
    padding: 4px 8px;
    border-radius: 999px;
    background: rgba(34, 211, 238, 0.12);
    color: #67e8f9;
    font-weight: 700;
    font-size: 0.85rem;
  }

  ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  li {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .badge {
    padding: 4px 8px;
    border-radius: 8px;
    font-size: 0.8rem;
    font-weight: 700;
    background: rgba(148, 163, 184, 0.15);
    color: #cbd5f5;
  }

  .badge.agentstep {
    background: rgba(59, 130, 246, 0.2);
    color: #93c5fd;
  }

  .badge.codestep {
    background: rgba(34, 197, 94, 0.2);
    color: #86efac;
  }

  .badge.approvalstep {
    background: rgba(251, 191, 36, 0.2);
    color: #fcd34d;
  }

  .badge.triggerstep {
    background: rgba(217, 70, 239, 0.2);
    color: #f0abfc;
  }

  .node-name {
    flex: 1;
  }

  .muted {
    color: #94a3b8;
  }

  .mono {
    font-family: 'SFMono-Regular', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
      'Courier New', monospace;
    font-size: 0.85rem;
  }

  footer {
    display: flex;
    justify-content: space-between;
    color: #cbd5f5;
    font-size: 0.9rem;
  }

  .placeholder,
  .error {
    padding: 14px;
    border-radius: 12px;
    border: 1px dashed rgba(148, 163, 184, 0.3);
    background: rgba(15, 23, 42, 0.4);
  }

  .error {
    border-color: rgba(248, 113, 113, 0.5);
    color: #fecdd3;
  }
</style>
