import { writable, get } from 'svelte/store';
import { readFile, writeFile, readDir, type DirEntry } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';

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
            const decoder = new TextDecoder();
            const data = await readFile(path);
            const text = decoder.decode(data);
            fileContents.update(c => ({ ...c, [path]: text }));
        }

        activeFile.set(path);
    } catch (e) {
        console.error('Failed to open file:', path, e);
    }
}

export async function saveFile(path: string, content: string) {
    try {
        const encoder = new TextEncoder();
        await writeFile(path, encoder.encode(content));
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
