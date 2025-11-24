import { orchestratorBaseUrl } from '$lib/config';
import { z } from 'zod';

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface FsService {
  readDir(path: string): Promise<FileEntry[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  join(...segments: string[]): Promise<string>;
  getDefaultRoot(): Promise<string>;
  pickDirectory(): Promise<string | null>;
}

const DEFAULT_REMOTE_ROOT = '/workspace';

const normalizeSlashes = (value: string) => value.replace(/\\+/g, '/');
const collapseDuplicateSlashes = (value: string) => value.replace(/\/{2,}/g, '/');
const stripTrailingSlashes = (value: string) => value.replace(/\/+$/, '');

const normalizeRemoteRoot = (value: string | undefined | null): string => {
  const trimmed = value?.trim();
  const fallback = DEFAULT_REMOTE_ROOT;

  if (!trimmed) return fallback;

  const normalized = collapseDuplicateSlashes(normalizeSlashes(trimmed));
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  const withoutTrailingSlash = stripTrailingSlashes(withLeadingSlash);

  return withoutTrailingSlash.length > 0 ? withoutTrailingSlash : fallback;
};

const remoteFsRoot = normalizeRemoteRoot(import.meta.env.VITE_REMOTE_FS_ROOT as string | undefined);

const normalizeRemoteBaseUrl = (value: string | undefined | null) => {
  const trimmed = value?.trim();
  if (!trimmed) return orchestratorBaseUrl;

  const normalized = stripTrailingSlashes(trimmed);
  return normalized.length > 0 ? normalized : orchestratorBaseUrl;
};

const normalizeRemotePath = (inputPath: string): string => {
  const normalized = collapseDuplicateSlashes(normalizeSlashes(inputPath));
  const absolute = normalized.startsWith('/') ? normalized : `/${normalized}`;

  const rootSegments = remoteFsRoot.split('/').filter(Boolean);
  const incomingSegments = absolute.split('/').filter(Boolean);

  let offset = 0;
  while (offset < rootSegments.length && incomingSegments[offset] === rootSegments[offset]) {
    offset += 1;
  }

  const relativeSegments = incomingSegments.slice(offset);
  const resolved = [...rootSegments];

  for (const segment of relativeSegments) {
    if (segment === '..') {
      if (resolved.length > rootSegments.length) {
        resolved.pop();
      }
      continue;
    }

    if (segment === '.' || !segment) continue;
    resolved.push(segment);
  }

  return `/${resolved.join('/')}`;
};

type DesktopWindow = typeof window & { __TAURI__?: unknown };

export const isDesktop = () =>
  typeof window !== 'undefined' && Boolean((window as DesktopWindow).__TAURI__);

class TauriFsService implements FsService {
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  async readDir(path: string): Promise<FileEntry[]> {
    const [{ readDir }, { join }] = await Promise.all([
      import('@tauri-apps/plugin-fs'),
      import('@tauri-apps/api/path')
    ]);
    const entries = await readDir(path);

    const resolvedEntries = await Promise.all(
      entries.map(async (entry) => {
        if (!entry.name) return null;

        const resolvedPath =
          'path' in entry && typeof (entry as { path?: string }).path === 'string'
            ? (entry as { path: string }).path
            : await join(path, entry.name);
        return {
          name: entry.name,
          path: resolvedPath,
          isDirectory: Boolean(entry.isDirectory)
        } satisfies FileEntry;
      })
    );

    return resolvedEntries.filter((entry): entry is FileEntry => Boolean(entry));
  }

  async readFile(path: string): Promise<string> {
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const payload = await readFile(path);
    return this.decoder.decode(payload);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    await writeFile(path, this.encoder.encode(content));
  }

  async join(...segments: string[]): Promise<string> {
    const { join } = await import('@tauri-apps/api/path');
    return join(...segments);
  }

  async getDefaultRoot(): Promise<string> {
    const { documentDir } = await import('@tauri-apps/api/path');
    return documentDir();
  }

  async pickDirectory(): Promise<string | null> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({ directory: true });
    if (Array.isArray(result)) return result[0] ?? null;
    return typeof result === 'string' ? result : null;
  }
}

type RemoteFsOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

class RemoteFsService implements FsService {
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private lastRequestAt = 0;
  private readonly minIntervalMs = 100;
  private throttleChain: Promise<void> = Promise.resolve();

  constructor({ baseUrl, fetchImpl }: RemoteFsOptions = {}) {
    const sanitizedBaseUrl = normalizeRemoteBaseUrl(baseUrl ?? orchestratorBaseUrl);
    this.baseUrl = `${sanitizedBaseUrl}/remote-fs`;
    this.fetchImpl = fetchImpl ?? fetch;
  }

  private throttle(): Promise<void> {
    this.throttleChain = this.throttleChain.then(async () => {
      const now = Date.now();
      const waitMs = Math.max(0, this.lastRequestAt + this.minIntervalMs - now);
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      this.lastRequestAt = Date.now();
    });

    return this.throttleChain;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    let response: Response;

    try {
      await this.throttle();
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        credentials: 'include',
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(init?.headers ?? {})
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      throw new Error(`Failed to reach remote FS: ${message}`);
    }

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Remote FS request failed (${response.status}): ${message || 'unknown error'}`);
    }

    return response;
  }

  async readDir(path: string): Promise<FileEntry[]> {
    const normalizedPath = normalizeRemotePath(path);
    const response = await this.request(`/list?path=${encodeURIComponent(normalizedPath)}`);
    const payload = await response.json();

    const entrySchema = z.object({
      name: z.string().min(1),
      path: z.string().optional(),
      isDirectory: z.boolean().optional()
    });
    const parsed = z.object({ entries: z.array(entrySchema) }).safeParse(payload);

    if (!parsed.success) {
      throw new Error('Remote FS returned an invalid directory listing');
    }

    return parsed.data.entries
      .filter((entry) => entry.name)
      .map((entry) => {
        // Note: normalizedPath is the parent directory passed to readDir.
        const pathSource = entry.path || entry.name;
        const pathCandidate = pathSource.startsWith('/')
          ? pathSource
          : this.joinSync(normalizedPath, pathSource);
        const resolvedPath = this.normalizePath(pathCandidate);

        return {
          name: entry.name,
          path: resolvedPath,
          isDirectory: Boolean(entry.isDirectory)
        } satisfies FileEntry;
      });
  }

  async readFile(path: string): Promise<string> {
    const normalizedPath = normalizeRemotePath(path);
    const response = await this.request(`/read?path=${encodeURIComponent(normalizedPath)}`);
    const payload = await response.json();

    const schema = z.object({ content: z.string() });
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new Error('Remote FS returned an invalid file payload');
    }
    return parsed.data.content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const normalizedPath = normalizeRemotePath(path);
    await this.request('/write', {
      method: 'POST',
      body: JSON.stringify({ path: normalizedPath, content })
    });
  }

  async join(...segments: string[]): Promise<string> {
    return this.normalizePath(this.joinSync(...segments));
  }

  private joinSync(...segments: string[]): string {
    return collapseDuplicateSlashes(
      segments
        .filter((segment) => segment && segment.length > 0)
        .map((segment) => normalizeSlashes(segment))
        .join('/')
    );
  }

  private normalizePath(path: string): string {
    return normalizeRemotePath(path);
  }

  async getDefaultRoot(): Promise<string> {
    return remoteFsRoot;
  }

  /**
   * Temporary implementation: uses window.prompt for directory selection.
   * This provides a poor user experience and is inconsistent with the native picker in TauriFsService.
   * TODO: Replace with a proper modal dialog component.
   * In SSR contexts, returns null to indicate directory picking is not supported.
   */
  async pickDirectory(): Promise<string | null> {
    if (typeof window === 'undefined') return null;
    const choice = window.prompt('Enter remote directory path', remoteFsRoot);
    return choice ? normalizeRemotePath(choice.trim()) : null;
  }
}

let cachedService: FsService | null = null;

export const fsService = (): FsService => {
  if (cachedService) return cachedService;
  cachedService = isDesktop() ? new TauriFsService() : new RemoteFsService();
  return cachedService;
};

export const resetFsService = () => {
  cachedService = null;
};

export const __fsTest = {
  RemoteFsService,
  TauriFsService,
  normalizeRemoteRoot,
  normalizeRemotePath
};
