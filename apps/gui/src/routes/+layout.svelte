<script lang="ts">
  import { page } from '$app/stores';
  import '../app.css';
  import FileTree from '$lib/components/ide/FileTree.svelte';
  import Editor from '$lib/components/ide/Editor.svelte';
  import Terminal from '$lib/components/ide/Terminal.svelte';
  import Chat from '$lib/components/ide/Chat.svelte';
  import ResizableSidebar from '$lib/components/layout/ResizableSidebar.svelte';
  import TerminalPanel from '$lib/components/layout/TerminalPanel.svelte';
  import Notifications from '$lib/components/Notifications.svelte';
  import {
    layoutState,
    LEFT_MAX,
    LEFT_MIN,
    RIGHT_MAX,
    RIGHT_MIN,
    TERMINAL_MAX,
    TERMINAL_MIN,
    setLeftWidth,
    setRightWidth,
    setTerminalHeight,
    toggleTerminal
  } from '$lib/stores/layout';

  const navLinks = [
    { href: '/', label: 'IDE' },
    { href: '/ops/cases', label: 'Ops' }
  ];

  $: isOpsMode = $page.url.pathname.startsWith('/ops');
</script>

<svelte:head>
  <title>Orchestrator IDE</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</svelte:head>

<div class="app-shell">
  <header class="topbar">
    <div class="brand">AI Agent Tool</div>
    <nav aria-label="Mode switch" class="nav-links">
      {#each navLinks as link}
        <a
          class="nav-link"
          class:active={link.href === '/' ? !isOpsMode : isOpsMode}
          href={link.href}
          aria-current={(link.href === '/' ? !isOpsMode : isOpsMode) ? 'page' : undefined}
        >
          {link.label}
        </a>
      {/each}
    </nav>
  </header>

  {#if isOpsMode}
    <div class="ops-shell">
      <main class="ops-main">
        <slot />
      </main>
    </div>
  {:else}
    <div class="ide-shell">
      <div
        class="ide-main"
        style={`--sidebar-left: ${$layoutState.leftWidth}px; --sidebar-right: ${$layoutState.rightWidth}px;`}
      >
        <ResizableSidebar
          side="left"
          width={$layoutState.leftWidth}
          minWidth={LEFT_MIN}
          maxWidth={LEFT_MAX}
          ariaLabel="File explorer"
          onResize={setLeftWidth}
        >
          <FileTree />
        </ResizableSidebar>

        <main class="editor-area">
          <Editor />
        </main>

        <ResizableSidebar
          side="right"
          width={$layoutState.rightWidth}
          minWidth={RIGHT_MIN}
          maxWidth={RIGHT_MAX}
          ariaLabel="Agent panel"
          onResize={setRightWidth}
        >
          <div class="agent-pane">
            <slot />
            <Chat />
          </div>
        </ResizableSidebar>
      </div>

      <TerminalPanel
        open={$layoutState.terminalOpen}
        height={$layoutState.terminalHeight}
        minHeight={TERMINAL_MIN}
        maxHeight={TERMINAL_MAX}
        onResize={setTerminalHeight}
        onToggle={toggleTerminal}
      >
        <Terminal />
      </TerminalPanel>
    </div>
  {/if}

  <Notifications />
</div>

<style>
  .app-shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
    padding: 12px;
    gap: 12px;
    background: radial-gradient(circle at 20% 20%, rgba(59, 130, 246, 0.12), rgba(10, 12, 24, 0.9)),
      radial-gradient(circle at 80% 0%, rgba(45, 212, 191, 0.12), rgba(15, 23, 42, 0.95)),
      #0b1020;
    color: #e2e8f0;
    box-sizing: border-box;
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-radius: 12px;
    background: rgba(15, 23, 42, 0.6);
    border: 1px solid rgba(148, 163, 184, 0.18);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
  }

  .brand {
    font-weight: 700;
    letter-spacing: 0.05em;
    color: #cbd5f5;
  }

  .nav-links {
    display: flex;
    gap: 8px;
  }

  .nav-link {
    padding: 8px 12px;
    border-radius: 10px;
    text-decoration: none;
    color: #cbd5f5;
    border: 1px solid transparent;
  }

  .nav-link:hover,
  .nav-link:focus-visible {
    border-color: rgba(148, 163, 184, 0.4);
    outline: none;
  }

  .nav-link.active {
    background: linear-gradient(135deg, #0ea5e9, #22d3ee);
    color: #0f172a;
    border-color: transparent;
  }

  .ide-shell {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex: 1;
    overflow: hidden;
  }

  .ops-shell {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: rgba(15, 23, 42, 0.55);
    border: 1px solid rgba(148, 163, 184, 0.12);
    border-radius: 16px;
    box-shadow: 0 16px 60px rgba(0, 0, 0, 0.35);
    padding: 16px;
  }

  .ops-main {
    flex: 1;
    overflow: auto;
  }

  .ide-main {
    flex: 1;
    display: grid;
    grid-template-columns: minmax(220px, var(--sidebar-left, 260px)) 1fr minmax(
        320px,
        var(--sidebar-right, 380px)
      );
    min-height: 0;
    gap: 12px;
    background: rgba(15, 23, 42, 0.55);
    border: 1px solid rgba(148, 163, 184, 0.12);
    border-radius: 18px;
    padding: 12px;
    box-shadow: 0 16px 60px rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(12px);
  }

  .editor-area {
    overflow: hidden;
    position: relative;
    background: linear-gradient(160deg, #0f172a 0%, #0b1020 100%);
    border-radius: 16px;
    border: 1px solid rgba(148, 163, 184, 0.12);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
  }

  .agent-pane {
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100%;
    overflow: hidden;
  }

</style>
