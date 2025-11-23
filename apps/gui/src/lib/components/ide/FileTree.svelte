<script lang="ts">
  import { fileTree, loadProject } from '$lib/stores/ide';
  import FileTreeNode from './FileTreeNode.svelte';
  import { onMount } from 'svelte';
  import { documentDir } from '@tauri-apps/api/path';
  import { open } from '@tauri-apps/plugin-dialog';

  let rootPath = '';

  onMount(async () => {
    // Default to document dir for now, or we could ask user to pick
    try {
      rootPath = await documentDir();
      await loadProject(rootPath);
    } catch (e) {
      console.error('Failed to load initial dir', e);
    }
  });

  async function pickFolder() {
    try {
      const selected = await open({ directory: true });
      if (selected) {
        const path = Array.isArray(selected) ? selected[0] : selected;
        if (path) loadProject(path);
      }
    } catch (e) {
      console.error('Failed to open dialog', e);
    }
  }
</script>

<div class="h-full flex flex-col bg-gray-900 text-gray-300 border-r border-gray-800">
  <div class="p-2 border-b border-gray-800 flex justify-between items-center">
    <span class="font-bold text-sm">EXPLORER</span>
    <button on:click={pickFolder} class="text-xs hover:text-white">Open...</button>
  </div>
  <div class="flex-1 overflow-auto p-1">
    {#each $fileTree as node (node.path)}
      <FileTreeNode {node} />
    {/each}
  </div>
</div>
