<script lang="ts">
  import { onMount } from 'svelte';

  type CaseRecord = {
    id: string;
    title: string;
    status: string;
    projectId?: string;
    updatedAt?: string;
  };

  let cases: CaseRecord[] = [];
  let loading = true;
  let error: string | null = null;

  async function loadCases() {
    loading = true;
    error = null;
    try {
      const response = await fetch('/cases');
      if (!response.ok) {
        throw new Error(`Failed to fetch cases (${response.status})`);
      }
      const payload = await response.json();
      cases = payload.cases ?? [];
    } catch (err) {
      error = err instanceof Error ? err.message : 'Unable to load cases';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void loadCases();
  });
</script>

<section class="ops-section">
  <header class="ops-header">
    <div>
      <p class="eyebrow">Operations</p>
      <h1>Cases</h1>
      <p class="subtitle">Track investigations and automation runs by case.</p>
    </div>
    <button class="ghost" on:click={loadCases} aria-live="polite">Refresh</button>
  </header>

  {#if loading}
    <div class="placeholder">Loading cases…</div>
  {:else if error}
    <div class="error">{error}</div>
  {:else if cases.length === 0}
    <div class="placeholder">No cases yet. New plans will register cases automatically.</div>
  {:else}
    <div class="table">
      <div class="row header" role="row">
        <div>Name</div>
        <div>Project</div>
        <div>Status</div>
        <div>Updated</div>
      </div>
      {#each cases as c}
        <div class="row" role="row">
          <div>{c.title}</div>
          <div>{c.projectId ?? '—'}</div>
          <div class={`status ${c.status}`}>{c.status}</div>
          <div>{c.updatedAt ? new Date(c.updatedAt).toLocaleString() : '—'}</div>
        </div>
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

  .table {
    display: grid;
    grid-template-columns: 1fr;
    gap: 6px;
  }

  .row {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr 1fr;
    gap: 12px;
    padding: 12px;
    border-radius: 12px;
    border: 1px solid rgba(148, 163, 184, 0.2);
    background: rgba(15, 23, 42, 0.6);
  }

  .header {
    font-weight: 700;
    color: #cbd5f5;
    background: rgba(15, 23, 42, 0.8);
  }

  .status {
    text-transform: capitalize;
    font-weight: 600;
  }

  .status.open {
    color: #38bdf8;
  }

  .status.active {
    color: #22d3ee;
  }

  .status.closed {
    color: #cbd5f5;
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
