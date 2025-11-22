<script lang="ts">
  import type { DiffPayload } from '$lib/stores/planTimeline';

  export let diff: DiffPayload;
</script>

<div class="diff-viewer">
  {#each diff.files as file (file.path)}
    <section class="diff-file">
      <header class="diff-file__header">
        <span class="diff-file__path">{file.path}</span>
      </header>
      <pre class="diff-file__body"><code>{file.patch}</code></pre>
    </section>
  {/each}
</div>

<style>
  .diff-viewer {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-top: 0.75rem;
  }

  .diff-file {
    border: 1px solid rgba(148, 163, 184, 0.35);
    border-radius: 0.75rem;
    overflow: hidden;
    background: rgba(15, 23, 42, 0.75);
  }

  .diff-file__header {
    padding: 0.5rem 0.75rem;
    background: rgba(79, 70, 229, 0.25);
    color: #c7d2fe;
    font-weight: 600;
    font-size: 0.85rem;
  }

  .diff-file__path {
    font-family: 'Fira Code', 'SFMono-Regular', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
      'Courier New', monospace;
  }

  .diff-file__body {
    margin: 0;
    padding: 0.75rem;
    overflow-x: auto;
    background: rgba(15, 23, 42, 0.85);
  }

  pre {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.4;
    font-family: 'Fira Code', 'SFMono-Regular', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
      'Courier New', monospace;
    color: #e2e8f0;
  }
</style>
