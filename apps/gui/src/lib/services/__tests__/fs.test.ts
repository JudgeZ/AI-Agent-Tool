import { afterEach, describe, expect, it, vi } from 'vitest';

import { orchestratorBaseUrl } from '$lib/config';
const tauriFsMock = {
  readDir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn()
};

const tauriPathMock = {
  join: vi.fn(),
  documentDir: vi.fn()
};

const tauriDialogMock = {
  open: vi.fn()
};

vi.mock('@tauri-apps/plugin-fs', () => tauriFsMock);
vi.mock('@tauri-apps/api/path', () => tauriPathMock);
vi.mock('@tauri-apps/plugin-dialog', () => tauriDialogMock);

import { __fsTest } from '../fs';

const { RemoteFsService, TauriFsService, normalizeRemoteRoot, normalizeRemotePath } = __fsTest;

describe('fs service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('normalizes remote roots consistently', () => {
    expect(normalizeRemoteRoot(undefined)).toBe('/workspace');
    expect(normalizeRemoteRoot('workspace/data')).toBe('/workspace/data');
    expect(normalizeRemoteRoot('\\network//share')).toBe('/network/share');
    expect(normalizeRemoteRoot('/already/ok/')).toBe('/already/ok');
    expect(normalizeRemoteRoot('  /trim/me// ')).toBe('/trim/me');
  });

  it('includes credentials and default headers for remote requests', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({ entries: [] })
    } as unknown as Response;

    const fetchSpy = vi.fn().mockResolvedValue(mockResponse);
    vi.stubGlobal('fetch', fetchSpy);

    const service = new RemoteFsService();
    await service.readDir('/workspace');

    expect(fetchSpy).toHaveBeenCalledWith(
      `${orchestratorBaseUrl}/remote-fs/list?path=%2Fworkspace`,
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({ 'content-type': 'application/json' })
      })
    );
  });

  it('sanitizes base urls while building requests', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({ entries: [] })
    } as unknown as Response;

    const fetchSpy = vi.fn().mockResolvedValue(mockResponse);
    const service = new RemoteFsService({ baseUrl: 'http://example.com///', fetchImpl: fetchSpy as any });

    await service.readDir('/workspace');

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://example.com/remote-fs/list?path=%2Fworkspace',
      expect.objectContaining({
        credentials: 'include'
      })
    );
  });

  it('falls back to orchestrator base url when provided base is empty', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({ entries: [] })
    } as unknown as Response;

    const fetchSpy = vi.fn().mockResolvedValue(mockResponse);
    const service = new RemoteFsService({ baseUrl: '   ///   ', fetchImpl: fetchSpy as any });

    await service.readDir('/workspace');

    expect(fetchSpy).toHaveBeenCalledWith(
      `${orchestratorBaseUrl}/remote-fs/list?path=%2Fworkspace`,
      expect.objectContaining({
        credentials: 'include'
      })
    );
  });

  it('wraps network failures with a clear error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    const service = new RemoteFsService();

    await expect(service.readDir('/workspace')).rejects.toThrow('Failed to reach remote FS: connection refused');
  });

  it('surfaces remote error payloads with status codes', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('boom')
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);

    const service = new RemoteFsService();

    await expect(service.readFile('/oops')).rejects.toThrow('Remote FS request failed (500): boom');
  });

  it('fills missing entry paths using normalized joins', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        entries: [
          { name: 'subdir', isDirectory: true },
          { name: 'file.txt', isDirectory: false }
        ]
      })
    } as unknown as Response);

    const service = new RemoteFsService({ baseUrl: 'http://example.com', fetchImpl: fetchSpy as any });
    const entries = await service.readDir('/workspace//project/');

    expect(entries).toEqual([
      { name: 'subdir', path: '/workspace/project/subdir', isDirectory: true },
      { name: 'file.txt', path: '/workspace/project/file.txt', isDirectory: false }
    ]);
  });

  it('normalizes remote entry paths provided by the server', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        entries: [
          { name: 'escape', path: '/workspace/../../escape', isDirectory: true },
          { name: 'file.txt', path: '/workspace/project//file.txt', isDirectory: false }
        ]
      })
    } as unknown as Response);

    const service = new RemoteFsService({ baseUrl: 'http://example.com', fetchImpl: fetchSpy as any });
    const entries = await service.readDir('/workspace/project/child');

    expect(entries).toEqual([
      { name: 'escape', path: '/workspace/escape', isDirectory: true },
      { name: 'file.txt', path: '/workspace/project/file.txt', isDirectory: false }
    ]);
  });

  it('anchors remote requests to the configured root', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ content: 'data' })
    } as unknown as Response);

    const service = new RemoteFsService({ baseUrl: 'http://example.com', fetchImpl: fetchSpy as any });

    await service.readFile('/etc/passwd');

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://example.com/remote-fs/read?path=%2Fworkspace%2Fetc%2Fpasswd',
      expect.objectContaining({
        credentials: 'include'
      })
    );
  });

  it('normalizes joined remote paths inside the root', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ entries: [] })
    } as unknown as Response);

    const service = new RemoteFsService({ baseUrl: 'http://example.com', fetchImpl: fetchSpy as any });

    const joined = await service.join('/workspace/project', '../secrets/../file.txt');

    expect(joined).toBe('/workspace/file.txt');
  });

  it('sanitizes picked directories to remain within the root', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('/../../escape');

    const service = new RemoteFsService({ baseUrl: 'http://example.com', fetchImpl: vi.fn() as any });
    const selection = await service.pickDirectory();

    expect(selection).toBe('/workspace/escape');
    promptSpy.mockRestore();
  });

  it('normalizes arbitrary remote paths for reuse', () => {
    expect(normalizeRemotePath('/workspace/../project/./file.txt')).toBe('/workspace/project/file.txt');
    expect(normalizeRemotePath('../relative/path')).toBe('/workspace/relative/path');
    expect(normalizeRemotePath('/workspace/deep/../../sibling')).toBe('/workspace/sibling');
  });

  it('issues remote writes with normalized payloads', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn(),
      text: vi.fn()
    } as unknown as Response);

    const service = new RemoteFsService({ baseUrl: 'http://example.com/', fetchImpl: fetchSpy as any });

    await service.writeFile('/workspace//project/../file.txt', 'content');

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://example.com/remote-fs/write',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: '/workspace/file.txt', content: 'content' })
      })
    );
  });

  it('reports the configured remote root by default', async () => {
    const service = new RemoteFsService({ baseUrl: 'http://example.com', fetchImpl: vi.fn() as any });

    await expect(service.getDefaultRoot()).resolves.toBe('/workspace');
  });

  describe('tauri implementation', () => {
    it('resolves entry paths using join and filters nameless entries', async () => {
      tauriFsMock.readDir.mockResolvedValue([
        { name: 'file.txt', path: '/root/file.txt', isDirectory: false },
        { name: 'folder', isDirectory: true },
        { name: '', path: '/root/hidden' }
      ]);
      tauriPathMock.join.mockResolvedValue('/root/folder');

      const service = new TauriFsService();
      const entries = await service.readDir('/root');

      expect(entries).toEqual([
        { name: 'file.txt', path: '/root/file.txt', isDirectory: false },
        { name: 'folder', path: '/root/folder', isDirectory: true }
      ]);
    });

    it('reads and writes files with encoder and decoder helpers', async () => {
      const encoded = new TextEncoder().encode('hello');
      tauriFsMock.readFile.mockResolvedValue(encoded);
      tauriFsMock.writeFile.mockResolvedValue();

      const service = new TauriFsService();

      await expect(service.readFile('/root/file.txt')).resolves.toBe('hello');

      await service.writeFile('/root/file.txt', 'world');

      expect(tauriFsMock.writeFile).toHaveBeenCalledTimes(1);
      const [, payload] = tauriFsMock.writeFile.mock.calls[0];
      const decoded = new TextDecoder().decode(payload as Uint8Array);
      expect(decoded).toBe('world');
    });

    it('delegates joins, default root lookup, and directory picking', async () => {
      tauriPathMock.join.mockResolvedValue('/joined/path');
      tauriPathMock.documentDir.mockResolvedValue('/documents');
      tauriDialogMock.open.mockResolvedValue(['/first', '/second']);

      const service = new TauriFsService();

      await expect(service.join('/a', '/b')).resolves.toBe('/joined/path');
      await expect(service.getDefaultRoot()).resolves.toBe('/documents');
      await expect(service.pickDirectory()).resolves.toBe('/first');

      tauriDialogMock.open.mockResolvedValue('/direct/path');
      await expect(service.pickDirectory()).resolves.toBe('/direct/path');
    });
  });
});
