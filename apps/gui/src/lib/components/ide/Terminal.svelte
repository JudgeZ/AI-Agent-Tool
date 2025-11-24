<script lang="ts">
  import { get } from 'svelte/store';
  import { onDestroy, onMount } from 'svelte';
  import { Terminal as Xterm } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import '@xterm/xterm/css/xterm.css';

  import { orchestratorBaseUrl } from '$lib/config';
  import { session } from '$lib/stores/session';
  import { resolveTerminalHaltMessage } from './terminalCloseReasons';

  type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

  const MAX_RECONNECT_ATTEMPTS = 6;
  const MAX_RECONNECT_DELAY_MS = 30_000;

  let container: HTMLDivElement | null = null;
  let term: Xterm | null = null;
  let fitAddon: FitAddon | null = null;
  let socket: WebSocket | null = null;
  let currentSessionId: string | null = null;
  let connectionStatus: ConnectionStatus = 'disconnected';
  let statusMessage = '';
  let unsubscribeSession: (() => void) | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let shouldReconnect = true;
  let reconnectionHalted = false;
  let resizeRaf: number | null = null;
  let lastSentCols = 0;
  let lastSentRows = 0;

  const toWebsocketUrl = (baseHttpUrl: string, sessionId: string): string => {
    const url = new URL(baseHttpUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/sandbox/terminal';
    url.search = new URLSearchParams({ sessionId }).toString();
    url.hash = '';
    return url.toString();
  };

  const setStatus = (status: ConnectionStatus, message = '') => {
    connectionStatus = status;
    statusMessage = message;
  };

  const detachSocket = () => {
    clearReconnectTimer();
    if (socket) {
      socket.onmessage = null;
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch (error) {
        console.warn('[terminal] Failed to close websocket', error);
      }
      socket = null;
    }
    currentSessionId = null;
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const haltReconnection = (message: string) => {
    shouldReconnect = false;
    reconnectionHalted = true;
    clearReconnectTimer();
    setStatus('error', message);
  };

  const scheduleReconnect = () => {
    if (!currentSessionId || !shouldReconnect) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      haltReconnection('Unable to reconnect. Please refresh or rejoin your session.');
      return;
    }
    clearReconnectTimer();
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** Math.min(reconnectAttempts, 5));
    setStatus('connecting', `Reconnecting in ${Math.round(delay / 1000)}s...`);
    reconnectTimer = setTimeout(() => {
      reconnectAttempts += 1;
      connect(currentSessionId as string);
    }, delay);
  };

  const retryConnection = () => {
    if (!currentSessionId) return;
    reconnectionHalted = false;
    reconnectAttempts = 0;
    shouldReconnect = true;
    clearReconnectTimer();
    connect(currentSessionId);
  };

  const handleMessage = (payload: unknown) => {
    if (typeof payload !== 'string') return;
    try {
      const data = JSON.parse(payload) as {
        type?: string;
        data?: string;
        status?: string;
        exitCode?: number;
        clients?: number;
      };
      if (!data || typeof data !== 'object') return;
      if (data.type === 'output' && typeof data.data === 'string') {
        term?.write(data.data);
      } else if (data.type === 'status') {
        if (typeof data.clients === 'number') {
          statusMessage = `Clients connected: ${data.clients}`;
        } else if (typeof data.status === 'string') {
          statusMessage = data.status;
        }
      } else if (data.type === 'exit') {
        setStatus('disconnected', `Session ended (code ${data.exitCode ?? 0})`);
        shouldReconnect = false;
        reconnectionHalted = true;
        clearReconnectTimer();
      }
    } catch (error) {
      console.warn('[terminal] Failed to parse message', error);
    }
  };

  const sendResize = () => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      if (!term || !fitAddon || !socket || socket.readyState !== WebSocket.OPEN) return;
      fitAddon.fit();
      const nextCols = term.cols;
      const nextRows = term.rows;
      if (nextCols < 1 || nextRows < 1) return;
      if (nextCols === lastSentCols && nextRows === lastSentRows) return;
      lastSentCols = nextCols;
      lastSentRows = nextRows;
      socket.send(JSON.stringify({ type: 'resize', cols: nextCols, rows: nextRows }));
    });
  };

  const setupTerminal = () => {
    if (!container) return;
    term = new Xterm({
      convertEol: true,
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SFMono-Regular', ui-monospace, 'DejaVu Sans Mono', monospace",
      theme: {
        background: '#050915',
        foreground: '#e2e8f0',
        cursor: '#22d3ee',
        black: '#0b1020',
        green: '#34d399',
        blue: '#60a5fa',
        cyan: '#22d3ee'
      }
    });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();
    term.focus();
    term.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data }));
      }
    });

    resizeObserver = new ResizeObserver(() => sendResize());
    resizeObserver.observe(container);
    window.addEventListener('resize', sendResize);
  };

  const teardownTerminal = () => {
    if (resizeRaf) {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = null;
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
    window.removeEventListener('resize', sendResize);
    fitAddon?.dispose?.();
    term?.dispose();
    fitAddon = null;
    term = null;
  };

  const connect = (sessionId: string) => {
    if (
      currentSessionId === sessionId &&
      socket &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    shouldReconnect = true;
    reconnectionHalted = false;
    clearReconnectTimer();
    detachSocket();
    const wsUrl = toWebsocketUrl(orchestratorBaseUrl, sessionId);
    setStatus('connecting', 'Opening terminal connection...');
    socket = new WebSocket(wsUrl);
    currentSessionId = sessionId;

    socket.onopen = () => {
      setStatus('connected', 'Terminal connected');
      reconnectAttempts = 0;
      lastSentCols = 0;
      lastSentRows = 0;
      clearReconnectTimer();
      sendResize();
    };

    socket.onmessage = (event) => handleMessage(event.data);
    socket.onerror = () => {
      setStatus('error', 'Terminal connection error');
      scheduleReconnect();
    };
    socket.onclose = (event) => {
      socket = null;
      const haltReason = resolveTerminalHaltMessage(event.code, event.reason);
      if (haltReason) {
        shouldReconnect = false;
        reconnectionHalted = true;
        clearReconnectTimer();
        setStatus(haltReason.status, haltReason.message);
        return;
      }
      if (reconnectionHalted) return;
      if (event.code >= 4000 && event.code < 5000) {
        haltReconnection('Terminal access denied. Please check your permissions.');
        return;
      }
      setStatus('disconnected', 'Terminal disconnected');
      scheduleReconnect();
    };
  };

  onMount(() => {
    setupTerminal();
    const state = get(session);
    if (state.authenticated && state.info?.id) {
      reconnectAttempts = 0;
      connect(state.info.id);
    } else {
      shouldReconnect = false;
      setStatus('disconnected', 'Sign in to start the terminal.');
    }

    unsubscribeSession = session.subscribe((value) => {
      if (!value.authenticated || !value.info?.id) {
        shouldReconnect = false;
        setStatus('disconnected', 'Sign in to start the terminal.');
        detachSocket();
        return;
      }

      if (reconnectionHalted && value.info.id === currentSessionId) {
        return;
      }

      reconnectAttempts = 0;
      connect(value.info.id);
    });
  });

  onDestroy(() => {
    detachSocket();
    clearReconnectTimer();
    shouldReconnect = false;
    teardownTerminal();
    unsubscribeSession?.();
  });
</script>

<div class="terminal-wrapper" aria-live="polite">
  <div class="panel">
    <div class="status-bar" role="status" aria-label="Terminal connection status">
      <span class={`status-indicator ${connectionStatus}`} aria-live="polite">
        <span class="pulse" aria-hidden="true"></span>
        <span class="label">{connectionStatus}</span>
      </span>
      <div class="status-message" aria-live="polite">
        {#if statusMessage}
          <span>{statusMessage}</span>
        {:else}
          <span>Bridge your workspace and the agent runtime in real time.</span>
        {/if}
      </div>
      {#if reconnectionHalted && currentSessionId}
        <button class="retry" type="button" on:click={retryConnection} aria-label="Retry terminal connection">
          ↻ Reconnect
        </button>
      {/if}
    </div>
    <div class="terminal-surface" bind:this={container} aria-label="Interactive terminal"></div>
  </div>
</div>

<style>
  .terminal-wrapper {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: radial-gradient(circle at 20% 20%, rgba(34, 211, 238, 0.05), transparent 30%),
      radial-gradient(circle at 80% 0%, rgba(99, 102, 241, 0.04), transparent 25%),
      linear-gradient(145deg, #050915 0%, #0b1020 45%, #0f172a 100%);
    padding: 0.75rem;
    border-radius: 16px;
    border: 1px solid rgba(148, 163, 184, 0.18);
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    height: 100%;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 14px;
    border: 1px solid rgba(148, 163, 184, 0.16);
    padding: 0.85rem;
    backdrop-filter: blur(6px);
  }

  .status-bar {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    color: #e2e8f0;
    font-size: 0.95rem;
  }

  .status-indicator {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0.7rem;
    border-radius: 999px;
    text-transform: capitalize;
    font-weight: 700;
    font-size: 0.85rem;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
  }

  .status-indicator.connected {
    background: linear-gradient(135deg, rgba(34, 211, 238, 0.2), rgba(52, 211, 153, 0.18));
    color: #a5f3fc;
  }

  .status-indicator.connecting {
    background: linear-gradient(135deg, rgba(96, 165, 250, 0.22), rgba(129, 140, 248, 0.18));
    color: #bfdbfe;
  }

  .status-indicator.disconnected {
    background: linear-gradient(135deg, rgba(148, 163, 184, 0.18), rgba(148, 163, 184, 0.1));
    color: #e2e8f0;
  }

  .status-indicator.error {
    background: linear-gradient(135deg, rgba(248, 113, 113, 0.18), rgba(248, 180, 83, 0.16));
    color: #fecdd3;
  }

  .pulse {
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 50%;
    background: currentColor;
    box-shadow: 0 0 0 0 rgba(255, 255, 255, 0.25);
    animation: pulse 2.2s infinite;
  }

  .label {
    letter-spacing: 0.01em;
  }

  @keyframes pulse {
    0% {
      box-shadow: 0 0 0 0 rgba(255, 255, 255, 0.25);
    }
    70% {
      box-shadow: 0 0 0 10px rgba(255, 255, 255, 0);
    }
    100% {
      box-shadow: 0 0 0 0 rgba(255, 255, 255, 0);
    }
  }

  .status-message {
    flex: 1;
    color: #cbd5f5;
    font-size: 0.9rem;
    opacity: 0.9;
  }

  .terminal-surface {
    flex: 1;
    background: radial-gradient(circle at 30% 30%, rgba(34, 211, 238, 0.06), transparent 32%), #050915;
    border: 1px solid rgba(148, 163, 184, 0.25);
    border-radius: 12px;
    overflow: hidden;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }

  :global(.xterm) {
    padding: 10px 12px;
  }

  .retry {
    margin-left: auto;
    padding: 0.35rem 0.95rem;
    border-radius: 999px;
    border: 1px solid rgba(94, 234, 212, 0.7);
    background: linear-gradient(135deg, rgba(45, 212, 191, 0.16), rgba(34, 211, 238, 0.18));
    color: #ecfeff;
    font-weight: 700;
    cursor: pointer;
    transition: transform 140ms ease, box-shadow 180ms ease, filter 140ms ease;
    letter-spacing: 0.01em;
    backdrop-filter: blur(4px);
  }

  .retry:hover,
  .retry:focus-visible {
    transform: translateY(-1px) scale(1.01);
    box-shadow: 0 12px 30px rgba(34, 211, 238, 0.2);
    outline: none;
    filter: brightness(1.05);
  }
</style>
