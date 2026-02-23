import { createClient, WebDAVClient, FileStat } from 'webdav';
import { normalizePath } from 'obsidian';
import * as path from 'path';
import { MountPoint } from './types';

/**
 * WebDAVAdapter wraps the `webdav` npm client and exposes the same
 * surface area that VirtualAdapter uses for local fs operations, so
 * VirtualAdapter can delegate to it transparently for WebDAV mounts.
 *
 * Credentials: the URL, username, and any path prefix come from the
 * MountPoint fields. Passwords are intentionally NOT stored in data.json
 * (which syncs); they are kept in `sessionStorage` keyed by mount id and
 * must be re-entered after Obsidian restarts.
 *
 * Convention:
 *   mount.realPath   = server-relative base path, e.g. "/Documents/Work"
 *   mount.webdavUrl  = server root URL, e.g. "https://mycloud.com/dav"
 * Together they form the full resource base: "https://mycloud.com/dav/Documents/Work/..."
 */
export class WebDAVAdapter {
    private client: WebDAVClient;
    private baseUrl: string;

    constructor(webdavUrl: string, username?: string, password?: string) {
        this.baseUrl = webdavUrl.replace(/\/$/, '');
        if (username && password) {
            this.client = createClient(this.baseUrl, { username, password });
        } else if (username) {
            this.client = createClient(this.baseUrl, { username, password: '' });
        } else {
            this.client = createClient(this.baseUrl);
        }
    }

    // ------------------------------------------------------------------
    // Password-in-sessionStorage helpers
    // ------------------------------------------------------------------

    static savePassword(mountId: string, password: string): void {
        try {
            sessionStorage.setItem(`folderbridge-webdav-pw-${mountId}`, password);
        } catch { /* sessionStorage unavailable */ }
    }

    static loadPassword(mountId: string): string | null {
        try {
            return sessionStorage.getItem(`folderbridge-webdav-pw-${mountId}`);
        } catch {
            return null;
        }
    }

    static clearPassword(mountId: string): void {
        try {
            sessionStorage.removeItem(`folderbridge-webdav-pw-${mountId}`);
        } catch { /* ignore */ }
    }

    /** Build a WebDAVAdapter from a MountPoint, using the sessionStorage password. */
    static fromMount(mount: MountPoint): WebDAVAdapter | null {
        if (!mount.webdavUrl) return null;
        const password = mount.id ? WebDAVAdapter.loadPassword(mount.id) : null;
        return new WebDAVAdapter(mount.webdavUrl, mount.webdavUsername, password ?? undefined);
    }

    // ------------------------------------------------------------------
    // Path helpers
    // ------------------------------------------------------------------

    /**
     * Convert a server-relative path (e.g. "/Documents/Work/note.md") into
     * the form expected by the webdav client (path relative to client root).
     * The client root is the webdavUrl — server paths starting with "/" are
     * already relative to the server root, so we just return them as-is after
     * joining with the mount's realPath base when needed.
     */
    private toServerPath(serverRelativePath: string): string {
        // Normalize slashes
        return serverRelativePath.replace(/\\/g, '/');
    }

    // ------------------------------------------------------------------
    // exists
    // ------------------------------------------------------------------

    async exists(serverPath: string): Promise<boolean> {
        try {
            return await this.client.exists(this.toServerPath(serverPath));
        } catch {
            return false;
        }
    }

    // ------------------------------------------------------------------
    // stat
    // ------------------------------------------------------------------

    async stat(serverPath: string): Promise<{ type: 'file' | 'folder'; ctime: number; mtime: number; size: number } | null> {
        try {
            const info = await this.client.stat(this.toServerPath(serverPath)) as FileStat;
            return {
                type: info.type === 'directory' ? 'folder' : 'file',
                ctime: info.lastmod ? new Date(info.lastmod).getTime() : 0,
                mtime: info.lastmod ? new Date(info.lastmod).getTime() : 0,
                size: info.size ?? 0,
            };
        } catch {
            return null;
        }
    }

    // ------------------------------------------------------------------
    // list
    // ------------------------------------------------------------------

    async list(serverPath: string, virtualParentPath: string, mount: MountPoint): Promise<{ files: string[]; folders: string[] }> {
        const files: string[] = [];
        const folders: string[] = [];
        try {
            const contents = await this.client.getDirectoryContents(this.toServerPath(serverPath)) as FileStat[];
            const mountVirtual = normalizePath(mount.virtualPath);
            for (const item of contents) {
                const name = path.basename(item.filename.replace(/\//g, path.sep));
                const virtualChild = virtualParentPath
                    ? normalizePath(virtualParentPath + '/' + name)
                    : name;
                if (item.type === 'directory') {
                    folders.push(virtualChild);
                } else {
                    files.push(virtualChild);
                }
            }
        } catch (e) {
            console.error(`[Folder Bridge] WebDAV list failed for "${serverPath}":`, e);
        }
        return { files, folders };
    }

    // ------------------------------------------------------------------
    // read
    // ------------------------------------------------------------------

    async readText(serverPath: string): Promise<string> {
        const result = await this.client.getFileContents(this.toServerPath(serverPath), { format: 'text' });
        return result as string;
    }

    async readBinary(serverPath: string): Promise<ArrayBuffer> {
        const result = await this.client.getFileContents(this.toServerPath(serverPath), { format: 'binary' });
        const buf = result as Buffer;
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    }

    // ------------------------------------------------------------------
    // write
    // ------------------------------------------------------------------

    async writeText(serverPath: string, data: string): Promise<void> {
        await this.client.putFileContents(this.toServerPath(serverPath), data, { overwrite: true });
    }

    async writeBinary(serverPath: string, data: ArrayBuffer): Promise<void> {
        await this.client.putFileContents(this.toServerPath(serverPath), Buffer.from(data), { overwrite: true });
    }

    async append(serverPath: string, data: string): Promise<void> {
        let existing = '';
        try {
            existing = await this.readText(serverPath);
        } catch { /* file may not exist yet */ }
        await this.writeText(serverPath, existing + data);
    }

    // ------------------------------------------------------------------
    // mkdir
    // ------------------------------------------------------------------

    async mkdir(serverPath: string): Promise<void> {
        // Create directory and all missing ancestors
        const parts = serverPath.replace(/\\/g, '/').split('/').filter(Boolean);
        let cumulative = '';
        for (const part of parts) {
            cumulative += '/' + part;
            try {
                const exists = await this.client.exists(cumulative);
                if (!exists) {
                    await this.client.createDirectory(cumulative);
                }
            } catch { /* ignore if already exists */ }
        }
    }

    // ------------------------------------------------------------------
    // remove
    // ------------------------------------------------------------------

    async remove(serverPath: string): Promise<void> {
        await this.client.deleteFile(this.toServerPath(serverPath));
    }

    // ------------------------------------------------------------------
    // rename / copy
    // ------------------------------------------------------------------

    async rename(srcServerPath: string, dstServerPath: string): Promise<void> {
        await this.client.moveFile(
            this.toServerPath(srcServerPath),
            this.toServerPath(dstServerPath)
        );
    }

    async copy(srcServerPath: string, dstServerPath: string): Promise<void> {
        await this.client.copyFile(
            this.toServerPath(srcServerPath),
            this.toServerPath(dstServerPath)
        );
    }
}
