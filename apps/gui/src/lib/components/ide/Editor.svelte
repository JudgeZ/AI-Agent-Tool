<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as monaco from 'monaco-editor';
  import { activeFile, fileContents, saveFile, isDirty } from '$lib/stores/ide';

  let editorContainer: HTMLElement;
  let editor: monaco.editor.IStandaloneCodeEditor;
  let currentModel: monaco.editor.ITextModel | null = null;

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
            const value = editor.getValue();
            // Update dirty state
            isDirty.update(d => ({ ...d, [$activeFile!]: true }));
            // We might want to debounce saving to store or just keep it in editor until explicit save?
            // For now, let's just mark dirty.
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
    editor?.dispose();
  });

  // React to activeFile changes
  $: if (editor && $activeFile) {
    const content = $fileContents[$activeFile] || '';
    const ext = $activeFile.split('.').pop() || 'txt';
    const lang = getLangFromExt(ext);

    // Don't replace model if it's the same file to preserve undo stack?
    // For simplicity, just setValue for now.
    // Ideally we should manage models per file.
    
    // Check if we already have a model for this file
    // const uri = monaco.Uri.file($activeFile);
    // let model = monaco.editor.getModel(uri);
    // if (!model) {
    //     model = monaco.editor.createModel(content, lang, uri);
    // }
    // editor.setModel(model);
    
    // Simple approach:
    const currentVal = editor.getValue();
    if (currentVal !== content) {
        // Only update if content is different (e.g. newly loaded)
        // This is tricky because local edits might be ahead of store if we don't sync back immediately.
        // Let's assume store is source of truth on file switch.
        editor.setValue(content);
        monaco.editor.setModelLanguage(editor.getModel()!, lang);
    }
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
