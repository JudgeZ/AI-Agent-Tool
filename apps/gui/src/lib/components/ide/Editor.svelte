<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as monaco from 'monaco-editor';
  import * as Y from 'yjs';
  import { MonacoBinding } from 'y-monaco';
  import { WebsocketProvider } from 'y-websocket';
  import { Awareness } from 'y-protocols/awareness';
  import {
    activeFile,
    fileContents,
    saveFile,
    isDirty,
    deriveCollaborationRoom,
    setCollaborationStatus,
    resetCollaborationConnection,
    setCollaborationContext,
    restoreLocalCollaborationContext,
    getLocalProjectId,
    collaborationContextVersion,
    type CollaborationRoomInfo
  } from '$lib/stores/ide';
  import { gatewayBaseUrl } from '$lib/config';
  import { session } from '$lib/stores/session';

  let editorContainer: HTMLElement;
  let editor: monaco.editor.IStandaloneCodeEditor;
  let currentModel: monaco.editor.ITextModel | null = null;
  let binding: MonacoBinding | null = null;
  let provider: WebsocketProvider | null = null;
  let doc: Y.Doc | null = null;
  let yText: Y.Text | null = null;
  let textObserver: ((event: Y.YTextEvent) => void) | null = null;
  let queuedTextObserver: number | null = null;
  let attachedFile: string | null = null;
  let appliedContextVersion = 0;
  let configureRequestId = 0;
  let configureQueue: Promise<void> = Promise.resolve();

  // Worker setup for Monaco (Vite specific)
  import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
  import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
  import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
  import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
  import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

  self.MonacoEnvironment = {
    getWorker: function (_: any, label: string) {
      if (label === 'json') {
        return new jsonWorker();
      }
      if (label === 'css' || label === 'scss' || label === 'less') {
        return new cssWorker();
      }
      if (label === 'html' || label === 'handlebars' || label === 'razor') {
        return new htmlWorker();
      }
      if (label === 'typescript' || label === 'javascript') {
        return new tsWorker();
      }
      return new editorWorker();
    }
  };

  const websocketBase = toWebsocketBase(gatewayBaseUrl);

  onMount(() => {
    editor = monaco.editor.create(editorContainer, {
      value: '',
      language: 'plaintext',
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false }
    });

    editor.onDidChangeModelContent(() => {
      if ($activeFile) {
        isDirty.update((d) => ({ ...d, [$activeFile!]: true }));
      }
    });

    // Ctrl+S to save
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if ($activeFile) {
        saveFile($activeFile, editor.getValue());
      }
    });
  });

  onDestroy(() => {
    teardownCollaboration();
    editor?.dispose();
  });

  $: {
    if ($session.authenticated && $session.info) {
      setCollaborationContext({
        tenantId: $session.info.tenantId ?? undefined,
        projectId: $session.info.projectId ?? getLocalProjectId()
      });
    } else if (!$session.loading) {
      restoreLocalCollaborationContext();
    }
  }

  $: if (editor && $activeFile) {
    const forceReload = $collaborationContextVersion !== appliedContextVersion;
    void configureForFile($activeFile, forceReload);
  } else if (editor && !$activeFile) {
    attachedFile = null;
    teardownCollaboration();
    currentModel?.dispose();
    currentModel = null;
    editor.setValue('');
  }

  function toWebsocketBase(httpUrl: string) {
    const parsed = new URL(httpUrl);
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  }

  async function configureForFile(path: string, forceReload = false) {
    const requestId = ++configureRequestId;
    configureQueue = configureQueue.then(async () => {
      try {
        if (requestId !== configureRequestId) return;
        if (path === attachedFile && currentModel && !forceReload) return;
        attachedFile = path;
        teardownCollaboration();

        const content = $fileContents[path] ?? '';
        const lang = getLangFromExt(path.split('.').pop() || 'txt');

        currentModel?.dispose();
        const model = monaco.editor.createModel(content, lang);
        currentModel = model;
        editor.setModel(model);
        isDirty.update((d) => ({ ...d, [path]: false }));

        await setupCollaboration(model, content, path, requestId);
        if (requestId !== configureRequestId) {
          model.dispose();
          return;
        }
        appliedContextVersion = $collaborationContextVersion;
      } catch (error) {
        console.error('Failed to configure file for collaboration', { path, error });
        setCollaborationStatus('error');
      }
    });
    return configureQueue;
  }

  function setupTextObserver(filePath: string, requestId: number) {
    if (!yText) return;
    const observedText = yText;
    textObserver = () => {
      if (queuedTextObserver !== null) return;

      queuedTextObserver = requestAnimationFrame(() => {
        queuedTextObserver = null;
        if (requestId !== configureRequestId || observedText !== yText) return;
        const value = observedText.toString();
        fileContents.update((c) => ({ ...c, [filePath]: value }));
        isDirty.update((d) => ({ ...d, [filePath]: true }));
      });
    };
    observedText.observe(textObserver);
  }

  function setLocalAwareness(awareness: Awareness) {
    awareness.setLocalStateField('user', {
      name: $session.info?.name ?? $session.info?.email ?? 'Guest',
      color: userColor($session.info?.id ?? 'guest')
    });
  }

  function logCollaborationEvent(event: string, detail: Record<string, unknown> = {}) {
    console.info('[collaboration]', event, {
      file: attachedFile,
      sessionId: $session.info?.id,
      ...detail
    });
  }

  async function setupCollaboration(
    model: monaco.editor.ITextModel,
    initialContent: string,
    filePath: string,
    requestId: number
  ) {
    const isStale = () => requestId !== configureRequestId;
    const cleanupStaleCollaboration = () => {
      if (yText && textObserver) {
        yText.unobserve(textObserver);
      }
      if (queuedTextObserver !== null) {
        cancelAnimationFrame(queuedTextObserver);
        queuedTextObserver = null;
      }
      if (provider) {
        provider.destroy();
        provider = null;
      }
      if (doc) {
        doc.destroy();
        doc = null;
        yText = null;
      }
      textObserver = null;
    };

    if (isStale()) return;

    setCollaborationStatus('connecting');
    let roomInfo: CollaborationRoomInfo | null = null;

    try {
      roomInfo = await deriveCollaborationRoom(filePath);
      if (isStale()) return;
    } catch (error) {
      console.error('Failed to derive collaboration room', error);
      setCollaborationStatus('error');
      logCollaborationEvent('room-derivation-failed', { message: (error as Error).message });
      return;
    }

    if (!roomInfo) {
      setCollaborationStatus('error');
      logCollaborationEvent('room-derivation-failed');
      return;
    }

    doc = new Y.Doc({ gc: false });
    yText = doc.getText('content');
    if (yText.length === 0 && initialContent) {
      yText.insert(0, initialContent);
    }

    const awareness = new Awareness(doc);
    setupTextObserver(filePath, requestId);

    try {
      if (isStale()) {
        cleanupStaleCollaboration();
        return;
      }
      provider = new WebsocketProvider(
        websocketBase,
        buildRoomName(roomInfo),
        doc,
        {
          awareness,
          maxBackoffTime: 5000
        }
      );

      provider.on('status', (event: { status: string }) => {
        logCollaborationEvent('ws-status', { status: event.status, roomId: roomInfo?.roomId });
        if (event.status === 'connected') {
          setCollaborationStatus('connected');
        } else if (event.status === 'disconnected') {
          setCollaborationStatus('disconnected');
        } else {
          setCollaborationStatus('connecting');
        }
      });
      provider.on('connection-close', () => {
        logCollaborationEvent('ws-closed', { roomId: roomInfo?.roomId });
        setCollaborationStatus('disconnected');
      });
      provider.on('connection-error', () => {
        logCollaborationEvent('ws-error', { roomId: roomInfo?.roomId });
        setCollaborationStatus('error');
      });
    } catch (error) {
      console.error('Failed to initialize collaboration provider', error);
      setCollaborationStatus('error');
      logCollaborationEvent('ws-init-failed', { message: (error as Error).message });
      cleanupStaleCollaboration();
      return;
    }

    if (isStale()) {
      cleanupStaleCollaboration();
      return;
    }

    const activeAwareness = provider?.awareness ?? awareness;
    setLocalAwareness(activeAwareness);
    binding = new MonacoBinding(yText, model, new Set([editor]), activeAwareness);
  }

  function buildRoomName(info: CollaborationRoomInfo) {
    const params = new URLSearchParams({
      tenantId: info.tenantId,
      projectId: info.projectId,
      filePath: info.filePath,
      roomId: info.roomId,
      authMode: 'session'
    });

    if ($session.info?.id) {
      params.set('sessionId', $session.info.id);
    }
    if ($session.info?.sessionToken) {
      // NOTE: Query params may be logged by intermediaries; backend currently requires
      // tokens in the URL until an authenticated subprotocol is available.
      params.set('sessionToken', $session.info.sessionToken);
    }

    return `collaboration/ws?${params.toString()}`;
  }

  function teardownCollaboration() {
    binding?.destroy();
    binding = null;

    if (yText && textObserver) {
      yText.unobserve(textObserver);
    }
    textObserver = null;
    if (queuedTextObserver !== null) {
      cancelAnimationFrame(queuedTextObserver);
      queuedTextObserver = null;
    }

    provider?.destroy();
    provider = null;

    doc?.destroy();
    doc = null;
    yText = null;

    resetCollaborationConnection();
  }

  function userColor(seed: string) {
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) {
      hash = (hash << 5) - hash + seed.charCodeAt(i);
      hash |= 0;
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 60%)`;
  }

  function getLangFromExt(ext: string) {
    const map: Record<string, string> = {
      ts: 'typescript',
      js: 'javascript',
      json: 'json',
      html: 'html',
      css: 'css',
      md: 'markdown',
      rs: 'rust',
      go: 'go',
      py: 'python'
    };
    return map[ext] || 'plaintext';
  }
</script>

<div class="w-full h-full" bind:this={editorContainer}></div>
