import { get } from 'svelte/store';
import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';

import {
  __test,
  collaborationContext,
  collaborationContextVersion,
  collaborationStatus,
  currentRoomId,
  deriveCollaborationRoom,
  resetCollaborationState,
  resetCollaborationConnection,
  setCollaborationContext,
  setCollaborationStatus,
  setProjectRootForCollaboration
} from '../ide';

async function sha256Hex(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

describe('collaboration context', () => {
  beforeEach(() => {
    resetCollaborationState();
    setProjectRootForCollaboration(null);
    setCollaborationContext({ tenantId: 'tenant-a', projectId: 'project-a' });
  });

  it('only bumps context version when values change', () => {
    const initialVersion = get(collaborationContextVersion);

    setCollaborationContext({ tenantId: 'tenant-a' });
    expect(get(collaborationContextVersion)).toBe(initialVersion);

    setCollaborationContext({ tenantId: 'tenant-b' });
    expect(get(collaborationContext).tenantId).toBe('tenant-b');
    expect(get(collaborationContextVersion)).toBe(initialVersion + 1);
  });

  it('rejects unsafe tenant and project identifiers', () => {
    const initialVersion = get(collaborationContextVersion);

    setCollaborationContext({ tenantId: 'tenant-a ', projectId: 'project-a ' });
    expect(get(collaborationContext)).toEqual({ tenantId: 'tenant-a', projectId: 'project-a' });
    expect(get(collaborationContextVersion)).toBe(initialVersion);

    const currentVersion = get(collaborationContextVersion);
    setCollaborationContext({ tenantId: 'invalid tenant', projectId: 'project-a'.repeat(20) });
    expect(get(collaborationContext)).toEqual({ tenantId: 'tenant-a', projectId: 'project-a' });
    expect(get(collaborationContextVersion)).toBe(currentVersion);
  });
});

describe('collaboration room derivation', () => {
  const originalCrypto = globalThis.crypto;

  beforeEach(() => {
    resetCollaborationState();
    setProjectRootForCollaboration('/workspace/demo');
    setCollaborationContext({ tenantId: 'tenant-1', projectId: 'project-1' });
    __test.setRoomRateLimiterForTest({ capacity: 16, tokens: 16, refillIntervalMs: 1000 });
  });

  afterEach(() => {
    if (originalCrypto) {
      vi.stubGlobal('crypto', originalCrypto);
    } else {
      vi.unstubAllGlobals();
    }
  });

  it('computes deterministic room ids and normalizes file paths', async () => {
    const room = await deriveCollaborationRoom('/workspace/demo/src/main.ts');

    expect(room?.filePath).toBe('src/main.ts');
    expect(get(currentRoomId)).toBe(room?.roomId ?? null);

    const expectedId = await sha256Hex('tenant-1:project-1:src/main.ts');
    expect(room?.roomId).toBe(expectedId);
  });

  it('resets state when no file path is provided', async () => {
    setCollaborationStatus('connected');
    const room = await deriveCollaborationRoom(null);

    expect(room).toBeNull();
    expect(get(currentRoomId)).toBeNull();
    expect(get(collaborationStatus)).toBe('idle');
  });

  it('caches room derivation per context and root', async () => {
    const digestMock = vi.fn(async () => new Uint8Array(32).buffer);
    vi.stubGlobal('crypto', { subtle: { digest: digestMock } } as unknown as Crypto);

    const filePath = '/workspace/demo/src/main.ts';

    await deriveCollaborationRoom(filePath);
    await deriveCollaborationRoom(filePath);
    expect(digestMock).toHaveBeenCalledTimes(1);

    setCollaborationContext({ projectId: 'project-2' });
    await deriveCollaborationRoom(filePath);
    expect(digestMock).toHaveBeenCalledTimes(2);

    setProjectRootForCollaboration('/workspace/other');
    await deriveCollaborationRoom('/workspace/other/src/main.ts');
    expect(digestMock).toHaveBeenCalledTimes(3);
  });

  it('avoids cache collisions when identifiers contain colons', async () => {
    const digestMock = vi.fn(async () => new Uint8Array(32).buffer);
    vi.stubGlobal('crypto', { subtle: { digest: digestMock } } as unknown as Crypto);

    setProjectRootForCollaboration('/workspace/demo');
    setCollaborationContext({ tenantId: 'tenant:1', projectId: 'project-1' });
    await deriveCollaborationRoom('/workspace/demo/src/main.ts');

    setCollaborationContext({ tenantId: 'tenant-1', projectId: 'project:1' });
    await deriveCollaborationRoom('/workspace/demo/src/main.ts');

    expect(digestMock).toHaveBeenCalledTimes(2);
  });

  it('preserves cached rooms across connection resets but clears them on full reset', async () => {
    const digestMock = vi.fn(async () => new Uint8Array(32).buffer);
    vi.stubGlobal('crypto', { subtle: { digest: digestMock } } as unknown as Crypto);

    const filePath = '/workspace/demo/src/main.ts';

    await deriveCollaborationRoom(filePath);
    resetCollaborationConnection();
    await deriveCollaborationRoom(filePath);
    expect(digestMock).toHaveBeenCalledTimes(1);

    resetCollaborationState();
    await deriveCollaborationRoom(filePath);
    expect(digestMock).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest cached rooms when the cache limit is exceeded', async () => {
    const digestMock = vi.fn(async () => new Uint8Array(32).buffer);
    vi.stubGlobal('crypto', { subtle: { digest: digestMock } } as unknown as Crypto);

    const cacheLimit = __test.ROOM_CACHE_LIMIT;
    const basePath = '/workspace/demo/src/file';

    __test.setRoomRateLimiterForTest({ capacity: cacheLimit + 10, tokens: cacheLimit + 10 });

    for (let index = 0; index < cacheLimit + 5; index += 1) {
      await deriveCollaborationRoom(`${basePath}-${index}.ts`);
    }

    expect(__test.getRoomCacheSize()).toBe(cacheLimit);

    // Ensure the cache continues to respect the cap and still derives rooms
    await deriveCollaborationRoom(`${basePath}-new.ts`);
    expect(__test.getRoomCacheSize()).toBe(cacheLimit);
    expect(digestMock).toHaveBeenCalledTimes(cacheLimit + 6);
  });

  it('rejects files outside the normalized project root when root contains traversal', () => {
    expect(() => __test.toRelativeFilePath('/etc/passwd', '/workspace/demo/../../etc')).toThrow(
      'invalid path'
    );
  });

  it('applies rate limiting to uncached derivations', async () => {
    __test.setRoomRateLimiterForTest({ capacity: 1, tokens: 1, refillIntervalMs: 25 });
    const digestMock = vi.fn(async () => new Uint8Array(32).buffer);
    vi.stubGlobal('crypto', { subtle: { digest: digestMock } } as unknown as Crypto);

    const start = performance.now();
    await Promise.all([
      deriveCollaborationRoom('/workspace/demo/src/a.ts'),
      deriveCollaborationRoom('/workspace/demo/src/b.ts')
    ]);
    const elapsed = performance.now() - start;

    expect(digestMock).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(20);
  });

  it('resets the room derivation rate limiter with collaboration state', async () => {
    __test.setRoomRateLimiterForTest({ capacity: 2, tokens: 1, refillIntervalMs: 1000 });
    await deriveCollaborationRoom('/workspace/demo/src/a.ts');

    expect(__test.getRoomRateLimiterState().tokens).toBe(0);

    resetCollaborationState();
    expect(__test.getRoomRateLimiterState().tokens).toBe(2);
  });
});

describe('path normalization', () => {
  it('accepts filesystem roots', () => {
    expect(__test.normalizeAbsolutePath('/')).toBe('/');
    expect(__test.normalizeAbsolutePath('C:\\')).toBe('C:/');
  });

  it('rejects drive-relative paths', () => {
    expect(() => __test.normalizeAbsolutePath('C:folder/file.txt')).toThrow('invalid path');
  });
});
