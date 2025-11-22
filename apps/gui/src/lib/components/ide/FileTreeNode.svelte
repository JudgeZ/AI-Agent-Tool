<script lang="ts">
  import { expandDir, openFile, type FileNode, activeFile } from '$lib/stores/ide';

  export let node: FileNode;

  $: isActive = $activeFile === node.path;

  function handleClick() {
    if (node.isDirectory) {
      expandDir(node);
      // Toggle open state locally if store update is slow? 
      // The store update handles isOpen logic.
    } else {
      openFile(node.path);
    }
  }
</script>

<div class="pl-2">
  <button 
    class="w-full text-left flex items-center gap-1 py-0.5 px-1 rounded hover:bg-gray-800 {isActive ? 'bg-gray-800 text-blue-400' : ''}"
    on:click={handleClick}
  >
    <span class="text-xs opacity-70">
      {#if node.isDirectory}
        {node.isOpen ? '📂' : '📁'}
      {:else}
        📄
      {/if}
    </span>
    <span class="text-sm truncate">{node.name}</span>
  </button>

  {#if node.isDirectory && node.isOpen && node.children}
    <div class="border-l border-gray-800 ml-2">
      {#each node.children as child}
        <svelte:self node={child} />
      {/each}
    </div>
  {/if}
</div>
