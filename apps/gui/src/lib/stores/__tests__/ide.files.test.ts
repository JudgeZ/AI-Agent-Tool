import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readDir, readFile, writeFile } from '@tauri-apps/plugin-fs';

import {
  activeFile,
  closeFile,
  collaborationContext,
  collaborationStatus,
  currentRoomId,
  deriveCollaborationRoom,
  expandDir,
  fileContents,
  fileTree,
  getLocalProjectId,
  isDirty,
  loadProject,
  openFile,
  openFiles,
  resetCollaborationState,
  restoreLocalCollaborationContext,
  saveFile,
  setCollaborationContext,
  setProjectRootForCollaboration,
  __test
} from '../ide';

vi.mock('@tauri-apps/plugin-fs', () => {
  return {
    readDir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn()
  };
});

vi.mock('@tauri-apps/api/path', () => {
  return {
    join: vi.fn((...segments: string[]) => segments.join('/'))
  };
});

const decoder = new TextDecoder();

describe('ide store file operations and helpers', () => {
  const originalCrypto = globalThis.crypto;

  beforeEach(() => {
    vi.clearAllMocks();
    fileTree.set([]);
    openFiles.set([]);
    activeFile.set(null);
    fileContents.set({});
    isDirty.set({});
    resetCollaborationState();
    setProjectRootForCollaboration(null);
    setCollaborationContext({ tenantId: 'tenant-1', projectId: 'project-1' });
    if (originalCrypto) {
      vi.stubGlobal('crypto', originalCrypto);
    }
  });

  afterEach(() => {
    vi.resetAllMocks();
    if (originalCrypto) {
      vi.stubGlobal('crypto', originalCrypto);
    } else {
      vi.unstubAllGlobals();
    }
  });

  it('derives and normalizes project metadata when loading a project', async () => {
    vi.mocked(readDir).mockResolvedValue([
      { name: 'src', isDirectory: true },
      { name: 'README.md', isDirectory: false }
    ] as unknown as Awaited<ReturnType<typeof readDir>>);

    const projectPath = '/workspace/demo';
    await loadProject(projectPath);

    expect(get(fileTree)).toHaveLength(2);
    expect(get(collaborationContext).projectId.startsWith('local-')).toBe(true);

    const derivedProjectId = await __test.deriveLocalProjectId(projectPath);
    expect(get(collaborationContext).projectId).toBe(derivedProjectId);
    expect(getLocalProjectId()).toBe(derivedProjectId);

    const room = await deriveCollaborationRoom('/workspace/demo/src/index.ts');
    expect(room?.filePath).toBe('src/index.ts');
    expect(get(currentRoomId)).toBe(room?.roomId ?? null);
  });

  it('expands directory nodes lazily and marks them as open', async () => {
    vi.mocked(readDir).mockResolvedValue([
      { name: 'main.ts', isDirectory: false },
      { name: 'lib', isDirectory: true }
    ] as unknown as Awaited<ReturnType<typeof readDir>>);

    await loadProject('/workspace/demo');
    const [root] = get(fileTree);
    await expandDir(root);

    const [node] = get(fileTree);
    expect(node.isOpen).toBe(true);
    expect(node.children?.map((child) => child.name)).toEqual(['lib', 'main.ts']);
  });

  it('opens files, caches contents, and keeps the active file in sync', async () => {
    const filePath = '/workspace/demo/main.ts';
    const payload = new TextEncoder().encode('console.log("hi")');
    vi.mocked(readFile).mockResolvedValue(payload as unknown as Awaited<ReturnType<typeof readFile>>);

    await openFile(filePath);

    expect(get(openFiles)).toContain(filePath);
    expect(get(activeFile)).toBe(filePath);
    expect(get(fileContents)[filePath]).toBe(decoder.decode(payload));

    await openFile(filePath);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('saves file contents and clears dirty state', async () => {
    const filePath = '/workspace/demo/main.ts';
    isDirty.set({ [filePath]: true });

    await saveFile(filePath, 'updated');

    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(get(fileContents)[filePath]).toBe('updated');
    expect(get(isDirty)[filePath]).toBe(false);
  });

  it('closes files and reassigns the active file predictably', () => {
    openFiles.set(['/workspace/demo/a.ts', '/workspace/demo/b.ts']);
    activeFile.set('/workspace/demo/b.ts');

    closeFile('/workspace/demo/b.ts');

    expect(get(openFiles)).toEqual(['/workspace/demo/a.ts']);
    expect(get(activeFile)).toBe('/workspace/demo/a.ts');

    closeFile('/workspace/demo/a.ts');
    expect(get(activeFile)).toBeNull();
  });

  it('restores local collaboration context when remote data is missing', () => {
    setCollaborationContext({ tenantId: 'remote-tenant', projectId: 'remote-project' });
    __test.setLocalProjectId('default-project');
    restoreLocalCollaborationContext();

    expect(get(collaborationContext)).toMatchObject({ tenantId: 'default', projectId: 'default-project' });
  });

  it('handles collaboration room derivation failures gracefully', async () => {
    setProjectRootForCollaboration('/workspace/demo');
    const result = await deriveCollaborationRoom('../secrets.txt');

    expect(result).toBeNull();
    expect(get(collaborationStatus)).toBe('idle');
    expect(get(currentRoomId)).toBeNull();
  });

  it('normalizes and validates paths for collaboration contexts', async () => {
    const root = '/workspace/demo';
    setProjectRootForCollaboration(root);

    expect(__test.toRelativeFilePath('/workspace/demo//src/index.ts', root)).toBe('src/index.ts');
    expect(() => __test.toRelativeFilePath('/workspace/other/file.ts', root)).toThrow(
      'file is outside project root'
    );

    await expect(() => __test.normalizeRelativePath('../secret')).toThrowError('invalid path');
  });

  it('falls back to deterministic project ids when crypto is unavailable', async () => {
    vi.stubGlobal('crypto', undefined as unknown as Crypto);
    const projectId = await __test.deriveLocalProjectId('/workspace/demo');

    expect(projectId).toBe('local-demo');
  });

  it('sanitizes deterministic project ids derived from unsafe paths', async () => {
    vi.stubGlobal('crypto', undefined as unknown as Crypto);
    const projectId = await __test.deriveLocalProjectId('/workspace/demo project !@#');

    expect(projectId).toBe('local-demo-project');
    setCollaborationContext({ projectId });

    expect(get(collaborationContext).projectId).toBe('local-demo-project');
  });
});
