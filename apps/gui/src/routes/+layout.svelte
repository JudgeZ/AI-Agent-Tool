<script lang="ts">
  import '../app.css';
  import FileTree from '$lib/components/ide/FileTree.svelte';
  import Editor from '$lib/components/ide/Editor.svelte';
</script>

<svelte:head>
  <title>Orchestrator IDE</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</svelte:head>

<div class="ide-layout">
  <aside class="sidebar-left">
    <FileTree />
  </aside>
  <main class="editor-area">
    <Editor />
  </main>
  <aside class="sidebar-right">
    <slot />
  </aside>
</div>

<style>
  .ide-layout {
    display: grid;
    grid-template-columns: 250px 1fr 450px;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
    background-color: #0f172a;
    color: #e2e8f0;
  }

  .sidebar-left {
    border-right: 1px solid rgba(148, 163, 184, 0.1);
    overflow-y: auto;
    background-color: #0b1120;
  }

  .editor-area {
    overflow: hidden;
    position: relative;
    background-color: #1e1e1e; /* VS Code dark default */
  }

  .sidebar-right {
    border-left: 1px solid rgba(148, 163, 184, 0.1);
    overflow-y: auto;
    background-color: #0f172a;
    display: flex;
    flex-direction: column;
  }
</style>
