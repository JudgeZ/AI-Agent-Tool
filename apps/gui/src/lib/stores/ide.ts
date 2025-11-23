import { writable, get } from 'svelte/store';
import { readFile, writeFile, readDir } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { defaultTenantId } from '$lib/config';

export type CollaborationStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

interface CollaborationContext {
    tenantId: string;
    projectId: string;
}

export interface CollaborationRoomInfo extends CollaborationContext {
    filePath: string;
    roomId: string;
}

export interface FileNode {
    name: string;
    path: string;
    isDirectory: boolean;
    children?: FileNode[];
    isOpen?: boolean; // For directories
}

export const fileTree = writable<FileNode[]>([]);
export const openFiles = writable<string[]>([]);
export const activeFile = writable<string | null>(null);
export const fileContents = writable<Record<string, string>>({});
export const isDirty = writable<Record<string, boolean>>({});
export const collaborationStatus = writable<CollaborationStatus>('idle');
export const currentRoomId = writable<string | null>(null);
export const collaborationContextVersion = writable<number>(0);

const localProjectId = writable<string>('default-project');
const sharedTextEncoder = new TextEncoder();
const sharedTextDecoder = new TextDecoder();
const ROOM_CACHE_LIMIT = 256;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,64}$/;
const ROOM_DERIVATION_RATE_LIMIT = {
    capacity: 16,
    tokens: 16,
    refillIntervalMs: 1000,
    lastRefillTs: typeof performance !== 'undefined' ? performance.now() : Date.now()
};
export const collaborationContext = writable<CollaborationContext>({
    tenantId: defaultTenantId ?? 'default',
    projectId: 'default-project'
});
const projectRoot = writable<string | null>(null);
const roomCache = new Map<string, CollaborationRoomInfo>();
let roomCacheContextVersion = get(collaborationContextVersion);
let roomCacheRootSnapshot = get(projectRoot);

function sanitizeLocalProjectId(base: string | undefined | null): string {
    if (!base) {
        return 'default-project';
    }

    // This sanitizer emits identifiers that conform to SAFE_ID_PATTERN so they can be
    // safely reused by sanitizeContextId without further mutation.
    const safeBase = base
        .replace(/[^a-zA-Z0-9._:-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);

    return safeBase ? `local-${safeBase}` : 'default-project';
}

function nowMs(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

async function consumeRoomDerivationToken() {
    const currentTs = nowMs();
    const elapsed = currentTs - ROOM_DERIVATION_RATE_LIMIT.lastRefillTs;

    if (elapsed >= ROOM_DERIVATION_RATE_LIMIT.refillIntervalMs) {
        const refillCount = Math.floor(elapsed / ROOM_DERIVATION_RATE_LIMIT.refillIntervalMs);
        ROOM_DERIVATION_RATE_LIMIT.tokens = Math.min(
            ROOM_DERIVATION_RATE_LIMIT.capacity,
            ROOM_DERIVATION_RATE_LIMIT.tokens + refillCount
        );
        ROOM_DERIVATION_RATE_LIMIT.lastRefillTs += refillCount * ROOM_DERIVATION_RATE_LIMIT.refillIntervalMs;
    }

    if (ROOM_DERIVATION_RATE_LIMIT.tokens > 0) {
        ROOM_DERIVATION_RATE_LIMIT.tokens -= 1;
        return;
    }

    const waitMs = Math.max(
        ROOM_DERIVATION_RATE_LIMIT.refillIntervalMs - (currentTs - ROOM_DERIVATION_RATE_LIMIT.lastRefillTs),
        0
    );

    await new Promise(resolve => setTimeout(resolve, waitMs));
    return consumeRoomDerivationToken();
}

async function deriveLocalProjectId(path: string): Promise<string> {
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
    const fallback = sanitizeLocalProjectId(normalized.split('/').filter(Boolean).pop());

    if (typeof crypto === 'undefined' || !crypto.subtle) {
        return fallback;
    }

    try {
        const digest = await crypto.subtle.digest('SHA-256', sharedTextEncoder.encode(normalized));
        const hash = Array.from(new Uint8Array(digest))
            .map(byte => byte.toString(16).padStart(2, '0'))
            .join('');
        return `local-${hash.slice(0, 16)}`;
    } catch (error) {
        console.error('Failed to derive local project id', error);
        return fallback;
    }
}

// Helper to recursively build tree
async function buildTree(path: string): Promise<FileNode[]> {
    try {
        const entries = await readDir(path);
        const nodes: FileNode[] = [];

        for (const entry of entries) {
            // Skip hidden files/dirs for now
            if (entry.name.startsWith('.')) continue;

            const fullPath = await join(path, entry.name);
            nodes.push({
                name: entry.name,
                path: fullPath,
                isDirectory: entry.isDirectory,
                children: entry.isDirectory ? [] : undefined
            });
        }

        return nodes.sort((a, b) => {
            if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name);
            return a.isDirectory ? -1 : 1;
        });
    } catch (e) {
        console.error('Failed to read dir:', path, e);
        return [];
    }
}

export async function loadProject(path: string) {
    const tree = await buildTree(path);
    fileTree.set(tree);
    const normalizedPath = path.replace(/\\/g, '/');
    setProjectRootForCollaboration(normalizedPath);
    const projectId = await deriveLocalProjectId(normalizedPath);
    localProjectId.set(projectId);
    setCollaborationContext({ projectId });
}

export async function expandDir(node: FileNode) {
    if (!node.isDirectory) return;

    // This is a simplified update. In a real app we'd need to traverse the tree store to update the specific node.
    // For this MVP, we might just reload the children of the clicked node if we had a flat map or a better tree update logic.
    // Since we are using a simple recursive store, let's just re-fetch children and update the node in place (if we had reference).
    // Actually, let's make `loadProject` just load the root. `expandDir` needs to find the node in the tree and update it.

    // For MVP, let's just assume we load the root and maybe one level deep? 
    // No, we need lazy loading.

    const children = await buildTree(node.path);

    fileTree.update(tree => {
        return updateNodeInTree(tree, node.path, { children, isOpen: true });
    });
}

function updateNodeInTree(nodes: FileNode[], path: string, updates: Partial<FileNode>): FileNode[] {
    return nodes.map(node => {
        if (node.path === path) {
            return { ...node, ...updates };
        }
        if (node.children) {
            return { ...node, children: updateNodeInTree(node.children, path, updates) };
        }
        return node;
    });
}

export async function openFile(path: string) {
    try {
        // Check if already open
        const currentOpen = get(openFiles);
        if (!currentOpen.includes(path)) {
            openFiles.update(files => [...files, path]);
        }

        // Load content if not already loaded
        const contents = get(fileContents);
        if (contents[path] === undefined) {
            const data = await readFile(path);
            const text = sharedTextDecoder.decode(data);
            fileContents.update(c => ({ ...c, [path]: text }));
        }

        activeFile.set(path);
    } catch (e) {
        console.error('Failed to open file:', path, e);
    }
}

export async function saveFile(path: string, content: string) {
    try {
        await writeFile(path, sharedTextEncoder.encode(content));
        fileContents.update(c => ({ ...c, [path]: content }));
        isDirty.update(d => ({ ...d, [path]: false }));
    } catch (e) {
        console.error('Failed to save file:', path, e);
    }
}

export function closeFile(path: string) {
    openFiles.update(files => files.filter(f => f !== path));
    const active = get(activeFile);
    if (active === path) {
        const remaining = get(openFiles);
        activeFile.set(remaining.length > 0 ? remaining[remaining.length - 1] : null);
    }
    // Optional: clear content from memory to save RAM
}

function normalizeRelativePath(path: string): string {
    const sanitized = path.replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = sanitized.split('/');
    const normalized: string[] = [];

    for (const segment of segments) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            throw new Error('invalid path');
        }
        normalized.push(segment);
    }

    if (normalized.length === 0) {
        throw new Error('invalid path');
    }

    return normalized.join('/');
}

function normalizeAbsolutePath(path: string): string {
    const sanitized = path.replace(/\\/g, '/');
    const segments = sanitized.split('/');
    // Extract the portion after the drive letter; drive-relative paths like "C:folder" are invalid.
    const pathAfterDrive = sanitized.match(/^[a-zA-Z]:(.*)/)?.[1] ?? '';
    const isDriveRelative = pathAfterDrive.length > 0 && !pathAfterDrive.startsWith('/');
    const isAbsolute = sanitized.startsWith('/') || /^[a-zA-Z]:\//.test(sanitized);

    if (!isAbsolute || isDriveRelative) {
        throw new Error('invalid path');
    }

    let prefix = sanitized.startsWith('/') ? '/' : '';
    let startIndex = sanitized.startsWith('/') ? 1 : 0;

    if (/^[a-zA-Z]:$/.test(segments[0])) {
        prefix = `${segments[0]}/`;
        startIndex = 1;
    }

    const normalized: string[] = [];

    for (let index = startIndex; index < segments.length; index += 1) {
        const segment = segments[index];
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            throw new Error('invalid path');
        }
        normalized.push(segment);
    }

    if (normalized.length === 0) {
        return prefix || '/';
    }

    return `${prefix}${normalized.join('/')}`;
}

function toRelativeFilePath(filePath: string, root: string | null): string {
    if (!root) {
        const normalizedInput = filePath.replace(/\\/g, '/');
        if (normalizedInput.startsWith('/') || /^[a-zA-Z]:/.test(normalizedInput)) {
            throw new Error('invalid path');
        }

        return normalizeRelativePath(filePath);
    }

    const normalizedRoot = normalizeAbsolutePath(root);
    const normalizedFile = normalizeAbsolutePath(filePath);

    const normalizedRootWithSlash = normalizedRoot.endsWith('/')
        ? normalizedRoot
        : `${normalizedRoot}/`;

    if (!normalizedFile.startsWith(normalizedRootWithSlash)) {
        throw new Error('file is outside project root');
    }

    const trimmed = normalizedFile.slice(normalizedRoot.length).replace(/^\/+/, '');
    if (trimmed.length === 0) {
        throw new Error('invalid path');
    }

    return normalizeRelativePath(trimmed);
}

async function computeRoomId(tenantId: string, projectId: string, filePath: string): Promise<string> {
    const key = `${tenantId}:${projectId}:${filePath}`;
    if (typeof crypto === 'undefined' || !crypto.subtle) {
        throw new Error('crypto.subtle is not available to derive collaboration room id');
    }

    const hash = await crypto.subtle.digest('SHA-256', sharedTextEncoder.encode(key));
    return Array.from(new Uint8Array(hash))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

export const __test = {
    deriveLocalProjectId,
    normalizeRelativePath,
    normalizeAbsolutePath,
    toRelativeFilePath,
    computeRoomId,
    setLocalProjectId: (projectId: string) => localProjectId.set(projectId),
    ROOM_CACHE_LIMIT,
    getRoomCacheSize: () => roomCache.size,
    resetRoomRateLimiter: () => {
        ROOM_DERIVATION_RATE_LIMIT.tokens = ROOM_DERIVATION_RATE_LIMIT.capacity;
        ROOM_DERIVATION_RATE_LIMIT.lastRefillTs = nowMs();
    },
    setRoomRateLimiterForTest: ({
        capacity,
        tokens,
        refillIntervalMs
    }: {
        capacity: number;
        tokens?: number;
        refillIntervalMs?: number;
    }) => {
        ROOM_DERIVATION_RATE_LIMIT.capacity = capacity;
        ROOM_DERIVATION_RATE_LIMIT.tokens = tokens ?? capacity;
        ROOM_DERIVATION_RATE_LIMIT.refillIntervalMs = refillIntervalMs ?? ROOM_DERIVATION_RATE_LIMIT.refillIntervalMs;
        ROOM_DERIVATION_RATE_LIMIT.lastRefillTs = nowMs();
    },
    getRoomRateLimiterState: () => ({ ...ROOM_DERIVATION_RATE_LIMIT })
};

function sanitizeContextId(value: string, fallback: string): string {
    const trimmed = value.trim();
    if (trimmed.length > 64 || !SAFE_ID_PATTERN.test(trimmed)) {
        console.warn('Rejected unsafe collaboration context identifier, keeping previous value');
        return fallback;
    }
    return trimmed;
}

export function setCollaborationContext(update: Partial<CollaborationContext>) {
    collaborationContext.update(current => {
        const next = {
            tenantId: update.tenantId
                ? sanitizeContextId(update.tenantId, current.tenantId)
                : current.tenantId,
            projectId: update.projectId
                ? sanitizeContextId(update.projectId, current.projectId)
                : current.projectId
        } satisfies CollaborationContext;

        if (next.tenantId === current.tenantId && next.projectId === current.projectId) {
            return current;
        }

        collaborationContextVersion.update(version => version + 1);
        return next;
    });
}

export function setCollaborationStatus(status: CollaborationStatus) {
    collaborationStatus.set(status);
}

export function resetCollaborationConnection() {
    currentRoomId.set(null);
    collaborationStatus.set('idle');
}

export function resetCollaborationState() {
    resetCollaborationConnection();
    roomCache.clear();
    roomCacheContextVersion = get(collaborationContextVersion);
    roomCacheRootSnapshot = get(projectRoot);
    ROOM_DERIVATION_RATE_LIMIT.tokens = ROOM_DERIVATION_RATE_LIMIT.capacity;
    ROOM_DERIVATION_RATE_LIMIT.lastRefillTs = nowMs();
}

export function restoreLocalCollaborationContext() {
    const tenantId = defaultTenantId ?? 'default';
    const projectId = get(localProjectId);
    setCollaborationContext({ tenantId, projectId });
}

export function setProjectRootForCollaboration(root: string | null) {
    if (!root) {
        projectRoot.set(null);
        return;
    }

    try {
        projectRoot.set(normalizeAbsolutePath(root));
    } catch (error) {
        console.warn('Rejected invalid project root for collaboration', error);
        projectRoot.set(null);
    }
}

export function getLocalProjectId() {
    return get(localProjectId);
}

function invalidateRoomCache() {
    const currentVersion = get(collaborationContextVersion);
    const currentRoot = get(projectRoot);

    if (currentVersion !== roomCacheContextVersion || currentRoot !== roomCacheRootSnapshot) {
        roomCache.clear();
        roomCacheContextVersion = currentVersion;
        roomCacheRootSnapshot = currentRoot;
    }
}

export async function deriveCollaborationRoom(filePath: string | null): Promise<CollaborationRoomInfo | null> {
    if (!filePath) {
        resetCollaborationConnection();
        return null;
    }

    try {
        const context = get(collaborationContext);
        const root = get(projectRoot);
        const normalizedFilePath = filePath.replace(/\\/g, '/');

        invalidateRoomCache();

        const cacheKey = [context.tenantId, context.projectId, root ?? '', normalizedFilePath].join('\u0000');
        const cached = roomCache.get(cacheKey);
        if (cached) {
            currentRoomId.set(cached.roomId);
            return cached;
        }

        await consumeRoomDerivationToken();
        const relativePath = toRelativeFilePath(normalizedFilePath, root);
        const roomId = await computeRoomId(context.tenantId, context.projectId, relativePath);
        const info: CollaborationRoomInfo = {
            tenantId: context.tenantId,
            projectId: context.projectId,
            filePath: relativePath,
            roomId
        };
        if (roomCache.size >= ROOM_CACHE_LIMIT) {
            const oldestKey = roomCache.keys().next().value;
            if (oldestKey !== undefined) {
                roomCache.delete(oldestKey);
            }
        }
        roomCache.set(cacheKey, info);
        currentRoomId.set(roomId);
        return info;
    } catch (error) {
        console.error('Failed to derive collaboration room', error);
        resetCollaborationConnection();
        return null;
    }
}
