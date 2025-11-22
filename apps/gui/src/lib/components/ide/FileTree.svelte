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
        // For testing, maybe hardcode a path or let user input?
        // Let's try to load the current project if we can find it, or just Documents.
        // Actually, for the "Agent Tool", we probably want to open the workspace the agent is working on.
        // But for now, let's just load Documents/Cursor/OSS AI Agent Tool if it exists, or just Documents.
        await loadProject(rootPath);
    } catch (e) {
        console.error("Failed to load initial dir", e);
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
        console.error("Failed to open dialog", e);
      }
  }
</script>

<div class="h-full flex flex-col bg-gray-900 text-gray-300 border-r border-gray-800">
  <div class="p-2 border-b border-gray-800 flex justify-between items-center">
    <span class="font-bold text-sm">EXPLORER</span>
    <button on:click={pickFolder} class="text-xs hover:text-white">Open...</button>
  </div>
  <div class="flex-1 overflow-auto p-1">
    {#each $fileTree as node}
      <FileTreeNode {node} />
    {/each}
  </div>
</div>
