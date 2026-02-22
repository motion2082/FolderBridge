import * as chokidar from 'chokidar';
import { App, normalizePath } from 'obsidian';
import { MountPoint } from './types';
import { PathMapper } from './PathMapper';
import * as fs from 'fs';

export class FileWatcher {
    private app: App;
    private pathMapper: PathMapper;
    private isIgnored: (name: string, mount: MountPoint) => boolean;
    private watchers: Map<string, chokidar.FSWatcher> = new Map();

    constructor(app: App, pathMapper: PathMapper, isIgnored: (name: string, mount: MountPoint) => boolean) {
        this.app = app;
        this.pathMapper = pathMapper;
        this.isIgnored = isIgnored;
    }

    /**
     * Start watching a mount point for changes.
     */
    startWatching(mount: MountPoint): void {
        if (this.watchers.has(mount.id)) {
            this.stopWatching(mount);
        }

        const realPath = this.pathMapper.getEffectiveRealPath(mount);

        // [FEATURE_20260222] Initialize chokidar watcher for the mount's real path
        const watcher = chokidar.watch(realPath, {
            ignored: (testPath: string, stats?: fs.Stats) => {
                // Ignore hidden files/folders and node_modules
                const name = testPath.split(/[/\\]/).pop() || '';
                if (name.startsWith('.') || name === 'node_modules') return true;

                // Apply user-defined ignore rules
                if (this.isIgnored(name, mount)) return true;

                return false;
            },
            // SECURITY: Do not follow symlinks. If a symlink inside the mount points
            // outside the mount's real path, PathMapper.toVirtualPath() returns the
            // mount root (not undefined) for out-of-bounds paths, which would cause
            // vault.onChange to signal Obsidian to remove the entire mount from its
            // view. Disabling symlink-following prevents chokidar from ever emitting
            // events for paths outside the mount boundary.
            followSymlinks: false,
            ignoreInitial: true, // Don't trigger 'add' events for existing files on startup
            persistent: true,
            awaitWriteFinish: {
                stabilityThreshold: 500,
                pollInterval: 100
            }
        });

        watcher
            .on('add', (filePath) => this.handleEvent('file-created', filePath, mount))
            .on('change', (filePath) => this.handleEvent('modified', filePath, mount))
            .on('unlink', (filePath) => this.handleEvent('file-removed', filePath, mount))
            .on('addDir', (dirPath) => this.handleEvent('folder-created', dirPath, mount))
            .on('unlinkDir', (dirPath) => this.handleEvent('folder-removed', dirPath, mount))
            .on('error', (error) => console.error(`[FolderBridge] Watcher error for mount ${mount.virtualPath}:`, error));

        this.watchers.set(mount.id, watcher);
        console.log(`[FolderBridge] Started watching: ${realPath}`);
    }

    /**
     * Stop watching a mount point.
     */
    stopWatching(mount: MountPoint): void {
        const watcher = this.watchers.get(mount.id);
        if (watcher) {
            watcher.close();
            this.watchers.delete(mount.id);
            console.log(`[FolderBridge] Stopped watching: ${this.pathMapper.getEffectiveRealPath(mount)}`);
        }
    }

    /**
     * Stop all active watchers.
     */
    stopAll(): void {
        for (const watcher of this.watchers.values()) {
            watcher.close();
        }
        this.watchers.clear();
    }

    /**
     * Handle a filesystem event from chokidar.
     */
    private async handleEvent(eventType: string, realPath: string, mount: MountPoint): Promise<void> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const vault = this.app.vault as any;
        if (typeof vault.onChange !== 'function') return;

        const virtualPath = this.pathMapper.toVirtualPath(realPath, mount);
        const normalizedPath = normalizePath(virtualPath);

        try {
            const existsInVault = !!this.app.vault.getAbstractFileByPath(normalizedPath);

            if (eventType === 'file-created' || eventType === 'folder-created') {
                if (existsInVault) return; // Already known to Obsidian
            } else if (eventType === 'file-removed' || eventType === 'folder-removed' || eventType === 'modified') {
                if (!existsInVault) return; // Not known to Obsidian, nothing to remove/modify
            }

            if (eventType === 'file-created' || eventType === 'modified') {
                // Obsidian expects a stat object for created/modified files
                const stat = await this.app.vault.adapter.stat(normalizedPath);
                if (stat) {
                    await vault.onChange(eventType, normalizedPath, null, stat);
                }
            } else {
                // Removed events don't need a stat object
                await vault.onChange(eventType, normalizedPath, null, null);
            }

            // Trigger a raw event for plugins that listen to it
            if (eventType === 'modified') {
                await vault.onChange('raw', normalizedPath, null, null);
            }
        } catch (e) {
            console.debug(`[FolderBridge] Failed to handle watcher event ${eventType} for ${normalizedPath}:`, e);
        }
    }
}
