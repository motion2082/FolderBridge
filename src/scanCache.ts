import { DataAdapter, normalizePath } from 'obsidian';

export interface CachedEntry {
    path: string;
    type: 'file' | 'folder';
    mtime?: number;
    size?: number;
}

export interface MountScanCache {
    mountId: string;
    virtualPath: string;
    savedAt: number;
    entries: CachedEntry[];
}

export interface ReplayCacheDeps {
    hasAbstractFile(path: string): boolean;
    onFolderCreated(path: string): Promise<void>;
    onFileCreated(path: string, stat: null): Promise<void>;
}

export function isCacheFresh(mountCache: MountScanCache, maxAgeMs: number): boolean {
    return Date.now() - mountCache.savedAt < maxAgeMs;
}

export function getMountCachePath(cacheDir: string, mountId: string): string {
    return normalizePath(`${cacheDir}/scan-cache-${mountId}.json`);
}

export async function loadMountCache(
    adapter: DataAdapter,
    cacheDir: string,
    mountId: string,
): Promise<MountScanCache | null> {
    try {
        const raw = await adapter.read(getMountCachePath(cacheDir, mountId));
        const parsed = JSON.parse(raw) as unknown;
        if (
            typeof parsed === 'object' &&
            parsed !== null &&
            typeof (parsed as MountScanCache).mountId === 'string' &&
            Array.isArray((parsed as MountScanCache).entries)
        ) {
            return parsed as MountScanCache;
        }
        return null;
    } catch {
        return null;
    }
}

export async function saveMountCache(
    adapter: DataAdapter,
    cacheDir: string,
    mountId: string,
    cache: MountScanCache,
): Promise<void> {
    await adapter.write(getMountCachePath(cacheDir, mountId), JSON.stringify(cache));
}

export async function deleteMountCache(
    adapter: DataAdapter,
    cacheDir: string,
    mountId: string,
): Promise<void> {
    try {
        await adapter.remove(getMountCachePath(cacheDir, mountId));
    } catch {
        // File may not exist; ignore
    }
}

/**
 * Replay a mount's cached entries into the vault without hitting the filesystem.
 * Entries already known to the vault (hasAbstractFile) are skipped, so replaying
 * a stale cache is safe — the background scan will correct any phantom entries.
 */
export async function replayCacheToVault(
    mountCache: MountScanCache,
    deps: ReplayCacheDeps,
): Promise<void> {
    // Folders must be created before their children, so process in original order
    // (the cache is written in depth-first order by replayMountContentsToVault).
    let yieldCounter = 0;
    for (const entry of mountCache.entries) {
        const path = normalizePath(entry.path);
        if (deps.hasAbstractFile(path)) continue;

        if (entry.type === 'folder') {
            await deps.onFolderCreated(path);
        } else {
            await deps.onFileCreated(path, null);
        }

        // Yield to event loop every 100 entries to keep UI responsive
        yieldCounter++;
        if (yieldCounter % 100 === 0) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
    }
}
