import { normalizePath } from 'obsidian';
import { PathMapper } from './PathMapper';
import { SecurityManager } from './SecurityManager';
import { MountPoint } from './types';
import { WebDAVAdapter } from './WebDAVAdapter';
import {
	realPathToResourceUrl,
	tryReadAsDataUri,
	ensureLongPathPrefix,
	isReservedWindowsFilename,
	translateFsError,
	isCloudPlaceholder,
} from './OSHelpers';

// Lazy-loaded Node.js builtins — wrapped in try/catch so the bundle loads on
// Obsidian Mobile (Capacitor) where Node APIs are unavailable.  On mobile these
// will be null; local-mount operations gracefully fail while WebDAV mounts work.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const fs: typeof import('fs') = (() => { try { return (require as any)('fs'); } catch { return null as never; } })();
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const path: typeof import('path') = (() => { try { return (require as any)('path'); } catch { return null as never; } })();

/**
 * VirtualAdapter is a shim that wraps Obsidian's built-in FileSystemAdapter.
 *
 * For every vault I/O method it checks whether the requested path falls inside
 * a user-configured mount point.  If so, it routes the call through Node.js
 * `fs` APIs operating on the real external path.  Otherwise it delegates to
 * the original adapter unchanged.
 *
 * The class intentionally avoids `implements DataAdapter` so that we are not
 * required to satisfy every internal/undocumented method on the interface; we
 * forward unknowns to `original` via the Proxy installed in main.ts.
 */
export class VirtualAdapter {
	private original: unknown;
	private pathMapper: PathMapper;
	private security: SecurityManager;
	private dryRun: boolean;
	private onMountRootDelete: (mount: MountPoint) => Promise<'unmount' | 'delete' | 'cancel'>;
	private onMountRootMove: (mount: MountPoint, newVirtualPath: string) => Promise<void>;
	private isIgnored: (name: string, mount: MountPoint, mountRelativePath?: string) => boolean;
	/** WebDAV client instances keyed by mount.id, managed by the plugin. */
	private webdavAdapters: Map<string, WebDAVAdapter> = new Map();
	/** Max bytes for data: URI generation; configurable via plugin settings. */
	private maxDataUriBytes: number;

	constructor(
		original: unknown,
		pathMapper: PathMapper,
		security: SecurityManager,
		dryRun = false,
		maxDataUriBytes = 10 * 1024 * 1024,
		onMountRootDelete: (mount: MountPoint) => Promise<'unmount' | 'delete' | 'cancel'>,
		onMountRootMove: (mount: MountPoint, newVirtualPath: string) => Promise<void>,
		isIgnored: (name: string, mount: MountPoint, mountRelativePath?: string) => boolean
	) {
		this.original = original;
		this.pathMapper = pathMapper;
		this.security = security;
		this.dryRun = dryRun;
		this.maxDataUriBytes = maxDataUriBytes;
		this.onMountRootDelete = onMountRootDelete;
		this.onMountRootMove = onMountRootMove;
		this.isIgnored = isIgnored;
	}

	/** Register (or replace) the WebDAV client for a mount. */
	setWebDAVAdapter(mountId: string, adapter: WebDAVAdapter): void {
		this.webdavAdapters.set(mountId, adapter);
	}

	/** Remove the WebDAV client for a mount (called on unmount). */
	clearWebDAVAdapter(mountId: string): void {
		this.webdavAdapters.delete(mountId);
	}

	/** Update dry-run mode without reloading the plugin. */
	setDryRun(val: boolean): void { this.dryRun = val; }

	/** Update the data: URI size cap without reloading the plugin. */
	setMaxDataUri(bytes: number): void { this.maxDataUriBytes = bytes; }

	// ------------------------------------------------------------------
	// Delegation helper
	// ------------------------------------------------------------------

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private orig(): any { return this.original; }

	// ------------------------------------------------------------------
	// Path helpers
	// ------------------------------------------------------------------

	/**
	 * Translate a virtual vault path to a real filesystem path, applying the
	 * Windows long-path prefix (`\\?\`) when the path exceeds 255 characters.
	 */
	private toReal(normalizedPath: string, mount: MountPoint): string {
		return ensureLongPathPrefix(this.pathMapper.toRealPath(normalizedPath, mount));
	}

	/**
	 * Translate a virtual vault path to a server-relative WebDAV path.
	 * Unlike toReal(), this never applies the Windows long-path prefix and
	 * always uses forward slashes, as required by WebDAV URLs.
	 */
	private toServerPath(normalizedPath: string, mount: MountPoint): string {
		return this.pathMapper.toRealPath(normalizedPath, mount).replace(/\\/g, '/');
	}

	/**
	 * Return the WebDAVAdapter for a mount if it is a WebDAV mount, or null
	 * if it is a local mount (the typical case).
	 */
	private getWebDAV(mount: MountPoint): WebDAVAdapter | null {
		if (mount.mountType !== 'webdav') return null;
		return this.webdavAdapters.get(mount.id) ?? null;
	}

	// ------------------------------------------------------------------
	// Security helpers
	// ------------------------------------------------------------------

	private assertAllowed(realPath: string): void {
		if (!this.security.isAllowed(realPath)) {
			throw new Error(
				`Folder Bridge: "${realPath}" is not on the allowlist. ` +
				`Add the mount in plugin settings to permit access.`
			);
		}
	}

	/**
	 * On Windows, certain device names (CON, NUL, COM1-9, LPT1-9, etc.) are
	 * reserved by the OS and cannot be used as file or folder names.  Attempting
	 * to create them produces a cryptic OS error; this guard surfaces a clear
	 * message instead.
	 */
	private assertNotReserved(realPath: string): void {
		const base = path.basename(realPath);
		if (isReservedWindowsFilename(base)) {
			throw new Error(
				`Folder Bridge: "${base}" is a reserved device name on Windows and ` +
				`cannot be used as a file or folder name (e.g. CON, NUL, COM1-9, LPT1-9).`
			);
		}
	}

	private isPathIgnored(normalizedPath: string, mount: MountPoint): boolean {
		// Compute the path relative to the mount's virtual root for path-style patterns
		const mountVirtual = normalizePath(mount.virtualPath);
		const mountRelativePath: string | undefined = normalizedPath.startsWith(mountVirtual + '/')
			? normalizedPath.slice(mountVirtual.length + 1)
			: (normalizedPath === mountVirtual ? '' : undefined);

		const parts = normalizedPath.split('/');
		for (const part of parts) {
			if (part && this.isIgnored(part, mount, mountRelativePath)) return true;
		}
		return false;
	}

	// ------------------------------------------------------------------
	// getName
	// ------------------------------------------------------------------

	getName(): string { return 'VirtualAdapter'; }

	// ------------------------------------------------------------------
	// exists
	// ------------------------------------------------------------------

	async exists(normalizedPath: string, sensitive?: boolean): Promise<boolean> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (this.isPathIgnored(normalizedPath, mount)) return false;
			const webdav = this.getWebDAV(mount);
			if (webdav) return await webdav.exists(this.toServerPath(normalizedPath, mount));
			const realPath = this.toReal(normalizedPath, mount);
			try {
				await fs.promises.access(realPath, fs.constants.F_OK);
				return true;
			} catch {
				return false;
			}
		}

		// A path may not physically exist in the vault yet but still needs to
		// "exist" if it is a virtual parent directory of a mount.
		if (this.pathMapper.hasMountsUnder(normalizedPath)) {
			const real = await this.orig().exists(normalizedPath, sensitive);
			if (real) return true;
			return this.pathMapper.getVirtualMountsDirectChildren(normalizedPath).length > 0;
		}

		return this.orig().exists(normalizedPath, sensitive);
	}

	// ------------------------------------------------------------------
	// stat
	// ------------------------------------------------------------------

	async stat(normalizedPath: string): Promise<{ type: 'file' | 'folder'; ctime: number; mtime: number; size: number } | null> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (this.isPathIgnored(normalizedPath, mount)) return null;
			const webdav = this.getWebDAV(mount);
			if (webdav) return await webdav.stat(this.toServerPath(normalizedPath, mount));
			const realPath = this.toReal(normalizedPath, mount);
			try {
				const s = await fs.promises.stat(realPath);
				return {
					type: s.isDirectory() ? 'folder' : 'file',
					ctime: s.ctimeMs,
					mtime: s.mtimeMs,
					size: s.size,
				};
			} catch (e: any) {
				// Obsidian expects null for missing files, not an error
				if (e.code !== 'ENOENT') {
					console.debug(`[FolderBridge] stat failed for "${realPath}":`, e);
				}
				return null;
			}
		}

		// Virtual intermediate directory: a path that doesn't exist on disk but
		// is a parent of a mount (e.g. "Projects" when the mount is "Projects/Work").
		// Obsidian calls stat() on paths it knows exist (from exists()), so we must
		// return a synthetic folder stat rather than null.
		if (this.pathMapper.hasMountsUnder(normalizedPath)) {
			const real = await this.orig().stat(normalizedPath);
			if (real) return real;
			return { type: 'folder', ctime: 0, mtime: Date.now(), size: 0 };
		}

		return this.orig().stat(normalizedPath);
	}

	// ------------------------------------------------------------------
	// list
	// ------------------------------------------------------------------

	async list(normalizedPath: string): Promise<{ files: string[]; folders: string[] }> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			console.debug(`[FolderBridge] list: found mount for "${normalizedPath}"`);
			if (this.isPathIgnored(normalizedPath, mount)) {
				console.debug(`[FolderBridge] list: path is ignored, returning empty`);
				return { files: [], folders: [] };
			}
			const webdav = this.getWebDAV(mount);
			if (webdav) {
				const sp = this.toServerPath(normalizedPath, mount);
				return await webdav.list(sp, normalizedPath, mount);
			}
			const realPath = this.toReal(normalizedPath, mount);
			console.debug(`[FolderBridge] list: resolved to real path "${realPath}"`);
			try {
				return await this.listRealDirectory(realPath, normalizedPath, mount);
			} catch (e) {
				console.error(`[FolderBridge] list failed for mount "${mount.virtualPath}":`, e);
				// Return empty instead of throwing to avoid breaking the UI
				return { files: [], folders: [] };
			}
		}

		// Merge real vault listing with injected virtual mount folders
		let result: { files: string[]; folders: string[] };
		try {
			result = await this.orig().list(normalizedPath);
		} catch {
			// Path may only exist as a virtual parent of a mount
			result = { files: [], folders: [] };
		}

		const virtualChildren = this.pathMapper.getVirtualMountsDirectChildren(normalizedPath);
		for (const child of virtualChildren) {
			if (!result.folders.includes(child)) {
				result.folders.push(child);
			}
		}

		return result;
	}

	private async listRealDirectory(
		realDirPath: string,
		virtualParentPath: string,
		mount: MountPoint,
	): Promise<{ files: string[]; folders: string[] }> {
		const files: string[] = [];
		const folders: string[] = [];
		const MAX_ENTRIES = 10000; // Safety limit to prevent UI freeze on huge directories

		// Pre-compute the mount-relative parent path for path-style ignore patterns
		const mountVirtual = normalizePath(mount.virtualPath);
		const mountRelativeParent: string | undefined = virtualParentPath.startsWith(mountVirtual + '/')
			? virtualParentPath.slice(mountVirtual.length + 1)
			: (virtualParentPath === mountVirtual ? '' : undefined);

		let entries: import('fs').Dirent[];
		try {
			entries = await fs.promises.readdir(realDirPath, { withFileTypes: true });
		} catch (e) {
			const msg = translateFsError(e as NodeJS.ErrnoException, 'list');
			console.error(`[FolderBridge] Failed to list directory "${realDirPath}":`, msg);
			throw new Error(`Folder Bridge: Cannot list "${realDirPath}": ${msg}`);
		}

		console.debug(`[FolderBridge] listRealDirectory: found ${entries.length} entries in "${realDirPath}"`);

		// Warn if directory is extremely large
		if (entries.length > MAX_ENTRIES) {
			console.warn(`[FolderBridge] WARNING: Directory "${realDirPath}" contains ${entries.length} items. Plate Folder Bridge limits display to ${MAX_ENTRIES} items for performance.`);
		}

		for (let i = 0; i < entries.length && i < MAX_ENTRIES; i++) {
			const entry = entries[i];
			// Build the mount-relative path for this entry so path-style patterns work
			const entryMountRelativePath: string | undefined =
				mountRelativeParent !== undefined
					? (mountRelativeParent ? `${mountRelativeParent}/${entry.name}` : entry.name)
					: undefined;
			if (this.isIgnored(entry.name, mount, entryMountRelativePath)) continue;

			const virtualChild = virtualParentPath
				? normalizePath(virtualParentPath + '/' + entry.name)
				: entry.name;

			if (entry.isDirectory()) {
				folders.push(virtualChild);
			} else if (entry.isFile()) {
				files.push(virtualChild);
			} else if (entry.isSymbolicLink()) {
				// For very large directories, skip symlink resolution to avoid delay
				if (entries.length > 1000) {
					console.debug(`[FolderBridge] Skipping symlink resolution in large directory (${entries.length} items)`);
					// Assume it's a file (safer default)
					files.push(virtualChild);
				} else {
					// Resolve symlinks to determine actual type
					try {
						const s = await fs.promises.stat(path.join(realDirPath, entry.name));
						if (s.isDirectory()) {
							folders.push(virtualChild);
						} else {
							files.push(virtualChild);
						}
					} catch {
						// Broken symlink or permission error – skip silently
					}
				}
			}
		}

		console.debug(`[FolderBridge] listRealDirectory: returning ${folders.length} folders and ${files.length} files`);
		return { files, folders };
	}

	// ------------------------------------------------------------------
	// read / readBinary
	// ------------------------------------------------------------------

	async read(normalizedPath: string): Promise<string> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot read ignored path "${normalizedPath}"`);
			const webdav = this.getWebDAV(mount);
			if (webdav) return await webdav.readText(this.toServerPath(normalizedPath, mount));
			const realPath = this.toReal(normalizedPath, mount);
			this.assertAllowed(realPath);
			try {
				return await fs.promises.readFile(realPath, 'utf8');
			} catch (e: any) {
				console.error(`[FolderBridge] read failed for "${realPath}":`, e);
				if (e.code === 'ENOENT') {
					// Check whether the file is an online-only cloud placeholder
					// (e.g. OneDrive Files On Demand) before surfacing a raw ENOENT.
					if (await isCloudPlaceholder(realPath)) {
						throw new Error(
							`Folder Bridge: "${path.basename(realPath)}" is a cloud-only placeholder ` +
							`(OneDrive / SharePoint Files On Demand) and cannot be read while offline. ` +
							`Right-click the file and choose "Always keep on this device" to make it available locally.`
						);
					}
					// Genuinely missing — preserve ENOENT so Obsidian handles it normally
					const err = new Error(`ENOENT: no such file or directory, open '${realPath}'`);
					(err as any).code = 'ENOENT';
					throw err;
				}
				throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'read')}`);
			}
		}
		return this.orig().read(normalizedPath);
	}

	async readBinary(normalizedPath: string): Promise<ArrayBuffer> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot read ignored path "${normalizedPath}"`);
			const webdav = this.getWebDAV(mount);
			if (webdav) return await webdav.readBinary(this.toServerPath(normalizedPath, mount));
			const realPath = this.toReal(normalizedPath, mount);
			this.assertAllowed(realPath);
			try {
				const buf = await fs.promises.readFile(realPath);
				// Return a proper ArrayBuffer (buf.buffer may be a shared Buffer pool slice)
				return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
			} catch (e: any) {
				if (e.code === 'ENOENT') {
					if (await isCloudPlaceholder(realPath)) {
						throw new Error(
							`Folder Bridge: "${path.basename(realPath)}" is a cloud-only placeholder ` +
							`(OneDrive / SharePoint Files On Demand) and cannot be read while offline. ` +
							`Right-click the file and choose "Always keep on this device" to make it available locally.`
						);
					}
					const err = new Error(`ENOENT: no such file or directory, open '${realPath}'`);
					(err as any).code = 'ENOENT';
					throw err;
				}
				throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'readBinary')}`);
			}
		}
		return this.orig().readBinary(normalizedPath);
	}

	// ------------------------------------------------------------------
	// write / writeBinary / append / process
	// ------------------------------------------------------------------

	async write(normalizedPath: string, data: string, options?: unknown): Promise<void> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) throw new Error(`Folder Bridge: Mount "${mount.virtualPath}" is read-only.`);
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot write to ignored path "${normalizedPath}"`);
			const webdav = this.getWebDAV(mount);
			if (webdav) {
				if (this.dryRun) { console.log(`[Folder Bridge DryRun] webdav write → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await webdav.writeText(this.toServerPath(normalizedPath, mount), data);
				return;
			}
			const realPath = this.toReal(normalizedPath, mount);

			this.assertAllowed(realPath);
			this.assertNotReserved(realPath);
			if (this.dryRun) { console.log(`[FolderBridge DryRun] write → ${realPath}`); return; }
			try {
				await fs.promises.mkdir(path.dirname(realPath), { recursive: true });
				await fs.promises.writeFile(realPath, data, 'utf8');
				return;
			} catch (e) {
				const errorMsg = `Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'write')}`;
				console.error(`[FolderBridge] write failed for "${realPath}":`, e, errorMsg);
				throw new Error(errorMsg);
			}
		}
		return this.orig().write(normalizedPath, data, options);
	}

	async writeBinary(normalizedPath: string, data: ArrayBuffer, options?: unknown): Promise<void> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) throw new Error(`Folder Bridge: Mount "${mount.virtualPath}" is read-only.`);
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot write to ignored path "${normalizedPath}"`);
			const webdav = this.getWebDAV(mount);
			if (webdav) {
				if (this.dryRun) { console.log(`[Folder Bridge DryRun] webdav writeBinary → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await webdav.writeBinary(this.toServerPath(normalizedPath, mount), data);
				return;
			}
			const realPath = this.toReal(normalizedPath, mount);
			this.assertAllowed(realPath);
			this.assertNotReserved(realPath);
			if (this.dryRun) { console.log(`[FolderBridge DryRun] writeBinary → ${realPath}`); return; }
			try {
				await fs.promises.mkdir(path.dirname(realPath), { recursive: true });
				return await fs.promises.writeFile(realPath, Buffer.from(data));
			} catch (e) {
				throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'writeBinary')}`);
			}
		}
		return this.orig().writeBinary(normalizedPath, data, options);
	}

	async append(normalizedPath: string, data: string, options?: unknown): Promise<void> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) throw new Error(`Folder Bridge: Mount "${mount.virtualPath}" is read-only.`);
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot append to ignored path "${normalizedPath}"`);
			const webdav = this.getWebDAV(mount);
			if (webdav) {
				if (this.dryRun) { console.log(`[Folder Bridge DryRun] webdav append → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await webdav.append(this.toServerPath(normalizedPath, mount), data);
				return;
			}
			const realPath = this.toReal(normalizedPath, mount);
			this.assertAllowed(realPath);
			if (this.dryRun) { console.log(`[FolderBridge DryRun] append → ${realPath}`); return; }
			try {
				return await fs.promises.appendFile(realPath, data, 'utf8');
			} catch (e) {
				throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'append')}`);
			}
		}
		return this.orig().append(normalizedPath, data, options);
	}

	async process(
		normalizedPath: string,
		fn: (data: string) => string,
		options?: unknown,
	): Promise<string> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot process ignored path "${normalizedPath}"`);
			const content = await this.read(normalizedPath);
			const updated = fn(content);
			await this.write(normalizedPath, updated, options);
			return updated;
		}
		return this.orig().process(normalizedPath, fn, options);
	}

	// ------------------------------------------------------------------
	// getResourcePath
	// ------------------------------------------------------------------

	getResourcePath(normalizedPath: string): string {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			// NOTE: Vault.getResourcePath(TFile) is patched separately in main.ts because
			// Obsidian's renderer calls the vault-level method directly, not this adapter method.
			// Modern Obsidian (app://<vaultId>/) only serves vault-relative paths, so
			// external mounts must be served as data: URIs instead.
			// The size cap is configurable via plugin settings (maxDataUriMB).
			const realPath = this.pathMapper.toRealPath(normalizedPath, mount);
			return tryReadAsDataUri(realPath, this.maxDataUriBytes) ?? realPathToResourceUrl(realPath);
		}
		return this.orig().getResourcePath(normalizedPath);
	}

	// ------------------------------------------------------------------
	// mkdir
	// ------------------------------------------------------------------

	async mkdir(normalizedPath: string): Promise<void> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) throw new Error(`Folder Bridge: Mount "${mount.virtualPath}" is read-only.`);
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot create ignored path "${normalizedPath}"`);

			const realPath = this.toReal(normalizedPath, mount);

			const webdav = this.getWebDAV(mount);
			if (webdav) {
				if (this.dryRun) { console.log(`[FolderBridge DryRun] mkdir (webdav) → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await webdav.mkdir(this.toServerPath(normalizedPath, mount));
				return;
			}

			this.assertAllowed(realPath);
			this.assertNotReserved(realPath);

			if (this.dryRun) {
				console.log(`[FolderBridge DryRun] mkdir → ${realPath}`);
				return;
			}

			try {
				await fs.promises.mkdir(realPath, { recursive: true });
			} catch (e) {
				const errorMsg = `Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'mkdir')}`;
				console.error(`[FolderBridge] mkdir failed for "${realPath}":`, e, errorMsg);
				throw new Error(errorMsg);
			}
			return;
		}

		return this.orig().mkdir(normalizedPath);
	}

	// ------------------------------------------------------------------
	// trash / remove
	// ------------------------------------------------------------------

	private async handleRootMountDeletion(rootMount: MountPoint): Promise<boolean> {
		const action = await this.onMountRootDelete(rootMount);
		if (action === 'cancel') {
			throw new Error(`Folder Bridge: Deletion cancelled.`);
		}
		if (action === 'unmount') {
			// The callback handles the unmounting. We just return true to stop the real deletion.
			return true;
		}
		// action === 'delete'
		return false; // Proceed with real deletion
	}

	async trashSystem(normalizedPath: string): Promise<boolean> {
		const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
		if (rootMount) {
			const handled = await this.handleRootMountDeletion(rootMount);
			if (handled) return true;
		}

		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) throw new Error(`Folder Bridge: Mount "${mount.virtualPath}" is read-only.`);
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot trash ignored path "${normalizedPath}"`);
			const realPath = this.toReal(normalizedPath, mount);
			const webdavTS = this.getWebDAV(mount);
			if (webdavTS) {
				if (this.dryRun) { console.log(`[FolderBridge DryRun] trashSystem (webdav) → ${this.toServerPath(normalizedPath, mount)}`); return true; }
				await webdavTS.remove(this.toServerPath(normalizedPath, mount));
				return true;
			}
			this.assertAllowed(realPath);
			if (this.dryRun) { console.log(`[FolderBridge DryRun] trashSystem → ${realPath}`); return true; }
			try {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const { shell } = require('electron') as any;
				await shell.trashItem(realPath);
				return true;
			} catch {
				// Fallback: permanent delete
				await fs.promises.rm(realPath, { recursive: true, force: true });
				return true;
			}
		}
		return this.orig().trashSystem(normalizedPath);
	}

	async trashLocal(normalizedPath: string, system?: boolean): Promise<void> {
		const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
		if (rootMount) {
			const handled = await this.handleRootMountDeletion(rootMount);
			if (handled) return;
		}

		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) throw new Error(`Folder Bridge: Mount "${mount.virtualPath}" is read-only.`);
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot trash ignored path "${normalizedPath}"`);
			const realPath = this.toReal(normalizedPath, mount);
			const webdavTL = this.getWebDAV(mount);
			if (webdavTL) {
				if (this.dryRun) { console.log(`[FolderBridge DryRun] trashLocal (webdav) → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await webdavTL.remove(this.toServerPath(normalizedPath, mount));
				return;
			}
			this.assertAllowed(realPath);
			if (this.dryRun) { console.log(`[FolderBridge DryRun] trashLocal → ${realPath}`); return; }
			await fs.promises.rm(realPath, { recursive: true, force: true });
			return;
		}
		return this.orig().trashLocal(normalizedPath, system);
	}

	async rmdir(normalizedPath: string, recursive: boolean): Promise<void> {
		const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
		if (rootMount) {
			const handled = await this.handleRootMountDeletion(rootMount);
			if (handled) return;
		}

		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) throw new Error(`Folder Bridge: Mount "${mount.virtualPath}" is read-only.`);
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot remove ignored path "${normalizedPath}"`);
			const realPath = this.toReal(normalizedPath, mount);
			const webdavRD = this.getWebDAV(mount);
			if (webdavRD) {
				if (this.dryRun) { console.log(`[FolderBridge DryRun] rmdir (webdav) → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await webdavRD.remove(this.toServerPath(normalizedPath, mount));
				return;
			}
			this.assertAllowed(realPath);
			if (this.dryRun) { console.log(`[FolderBridge DryRun] rmdir → ${realPath}`); return; }
			await fs.promises.rm(realPath, { recursive: true, force: true });
			return;
		}
		if (typeof this.orig().rmdir === 'function') {
			return this.orig().rmdir(normalizedPath, recursive);
		}
	}

	async remove(normalizedPath: string): Promise<void> {
		const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
		if (rootMount) {
			const handled = await this.handleRootMountDeletion(rootMount);
			if (handled) return;
		}

		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) throw new Error(`Folder Bridge: Mount "${mount.virtualPath}" is read-only.`);
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot remove ignored path "${normalizedPath}"`);
			const realPath = this.toReal(normalizedPath, mount);
			const webdavRM = this.getWebDAV(mount);
			if (webdavRM) {
				if (this.dryRun) { console.log(`[FolderBridge DryRun] remove (webdav) → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await webdavRM.remove(this.toServerPath(normalizedPath, mount));
				return;
			}
			this.assertAllowed(realPath);
			if (this.dryRun) { console.log(`[FolderBridge DryRun] remove → ${realPath}`); return; }
			await fs.promises.rm(realPath, { recursive: true, force: true });
			return;
		}
		if (typeof this.orig().remove === 'function') {
			return this.orig().remove(normalizedPath);
		}
	}

	// ------------------------------------------------------------------
	// rename / copy
	// ------------------------------------------------------------------

	async rename(normalizedPath: string, newNormalizedPath: string): Promise<void> {
		const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
		if (rootMount) {
			// The user dragged or moved the mount root folder in the file explorer.
			// Delegate to the plugin's updateMount() via the onMountRootMove callback
			// so the virtual path is updated live without touching the real disk folder.
			await this.onMountRootMove(rootMount, newNormalizedPath);
			return;
		}

		const srcMount = this.pathMapper.getMountForPath(normalizedPath);
		const dstMount = this.pathMapper.getMountForPath(newNormalizedPath);

		if (!srcMount && !dstMount) {
			return this.orig().rename(normalizedPath, newNormalizedPath);
		}

		if (srcMount && dstMount && srcMount.id === dstMount.id) {
			// Rename within the same mount
			if (srcMount.readOnly) throw new Error(`Folder Bridge: Mount "${srcMount.virtualPath}" is read-only.`);
			if (this.isPathIgnored(normalizedPath, srcMount) || this.isPathIgnored(newNormalizedPath, dstMount)) {
				throw new Error(`Folder Bridge: Cannot rename ignored paths`);
			}
			const srcReal = this.toReal(normalizedPath, srcMount);
			const dstReal = this.toReal(newNormalizedPath, dstMount);
			const webdavRN = this.getWebDAV(srcMount);
			if (webdavRN) {
				if (this.dryRun) { console.log(`[FolderBridge DryRun] rename (webdav) ${this.toServerPath(normalizedPath, srcMount)} → ${this.toServerPath(newNormalizedPath, dstMount)}`); return; }
				await webdavRN.rename(this.toServerPath(normalizedPath, srcMount), this.toServerPath(newNormalizedPath, dstMount));
				return;
			}
			this.assertAllowed(srcReal);
			this.assertAllowed(dstReal);
			this.assertNotReserved(dstReal);
			if (this.dryRun) { console.log(`[FolderBridge DryRun] rename ${srcReal} → ${dstReal}`); return; }
			await fs.promises.mkdir(path.dirname(dstReal), { recursive: true });

			// Wait for srcReal to materialise before attempting the rename.
			// Obsidian's vault.create() may register a TFile in its in-memory
			// index and focus the inline-title editor *before* adapter.write()
			// has finished writing the file to disk.  If the user immediately
			// types a title and blurs, adapter.rename() is called while the
			// source path hasn't been written yet.  OneDrive cloud-sync operations
			// can also cause a transient ENOENT on a freshly-written file.
			const MAX_WAIT_MS = 2000;
			const POLL_MS = 100;
			let waited = 0;
			let srcExists = false;
			while (waited <= MAX_WAIT_MS) {
				try {
					await fs.promises.access(srcReal, fs.constants.F_OK);
					srcExists = true;
					break;
				} catch {
					if (waited >= MAX_WAIT_MS) break;
					await new Promise<void>(resolve => setTimeout(resolve, POLL_MS));
					waited += POLL_MS;
				}
			}

			if (!srcExists) {
				// Check for an idempotent rename: an external tool or a parallel
				// vault.create() path may have already moved the file.
				try {
					await fs.promises.access(dstReal, fs.constants.F_OK);
					return; // destination already exists – rename is effectively done
				} catch { /* neither end exists; fall through to throw */ }
				throw new Error(
					`Folder Bridge: Cannot rename "${path.basename(srcReal)}" – the source file was not found after ` +
					`waiting ${MAX_WAIT_MS}ms. ` +
					`If this file is in OneDrive "Files On Demand", right-click it in Windows Explorer and ` +
					`choose "Always keep on this device", then try again.`,
				);
			}

			try {
				await fs.promises.rename(srcReal, dstReal);
			} catch (e) {
				const err = e as NodeJS.ErrnoException;
				if (err.code === 'EXDEV') {
					// Cross-device move (e.g. different drive letters on Windows):
					// fall back to copy-then-delete so the operation succeeds transparently.
					// Use fs.promises.cp so that both files and directories are handled.
					await fs.promises.cp(srcReal, dstReal, { recursive: true });
					await fs.promises.rm(srcReal, { recursive: true });
					return;
				}
				throw new Error(`Folder Bridge: ${translateFsError(err, 'rename')}`);
			}
			return;
		}

		// Cross-mount or cross-adapter rename is not atomic – surface a clear error
		throw new Error(
			`Folder Bridge: Cannot move "${normalizedPath}" to "${newNormalizedPath}" across mount boundaries. ` +
			`Please copy the file manually instead.`
		);
	}

	async copy(normalizedPath: string, newNormalizedPath: string): Promise<void> {
		const srcMount = this.pathMapper.getMountForPath(normalizedPath);
		const dstMount = this.pathMapper.getMountForPath(newNormalizedPath);

		if (!srcMount && !dstMount) {
			return this.orig().copy(normalizedPath, newNormalizedPath);
		}

		if (dstMount?.readOnly) {
			throw new Error(`Folder Bridge: Mount "${dstMount.virtualPath}" is read-only.`);
		}

		if ((srcMount && this.isPathIgnored(normalizedPath, srcMount)) || (dstMount && this.isPathIgnored(newNormalizedPath, dstMount))) {
			throw new Error(`Folder Bridge: Cannot copy ignored paths`);
		}

		if (this.dryRun) {
			const srcDesc = srcMount ? this.pathMapper.toRealPath(normalizedPath, srcMount) : normalizedPath;
			const dstDesc = dstMount ? this.pathMapper.toRealPath(newNormalizedPath, dstMount) : newNormalizedPath;
			console.log(`[FolderBridge DryRun] copy ${srcDesc} → ${dstDesc}`);
			return;
		}

		try {
			const srcWebDAV = srcMount ? this.getWebDAV(srcMount) : null;
			const dstWebDAV = dstMount ? this.getWebDAV(dstMount) : null;

			// Server-side copy when both ends are on the same WebDAV mount
			if (srcWebDAV && dstWebDAV && srcMount!.id === dstMount!.id) {
				await srcWebDAV.copy(this.toServerPath(normalizedPath, srcMount!), this.toServerPath(newNormalizedPath, dstMount!));
				return;
			}

			// Read from source
			const content: Buffer = srcWebDAV
				? Buffer.from(await srcWebDAV.readBinary(this.toServerPath(normalizedPath, srcMount!)))
				: srcMount
					? await fs.promises.readFile(this.toReal(normalizedPath, srcMount))
					: Buffer.from(await this.orig().readBinary(normalizedPath) as ArrayBuffer);

			// Write to destination
			if (dstWebDAV) {
				await dstWebDAV.writeBinary(this.toServerPath(newNormalizedPath, dstMount!), content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer);
			} else if (dstMount) {
				const dstReal = this.toReal(newNormalizedPath, dstMount);
				this.assertAllowed(dstReal);
				this.assertNotReserved(dstReal);
				await fs.promises.mkdir(path.dirname(dstReal), { recursive: true });
				await fs.promises.writeFile(dstReal, content);
			} else {
				await this.orig().writeBinary(newNormalizedPath, content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer);
			}
		} catch (e) {
			// Re-throw FolderBridge errors unchanged; translate raw fs errors
			const err = e as Error;
			if (err.message.startsWith('Folder Bridge:')) throw err;
			throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'copy')}`);
		}
	}
}
