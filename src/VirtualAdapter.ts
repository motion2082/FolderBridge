import { normalizePath } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { PathMapper } from './PathMapper';
import { SecurityManager } from './SecurityManager';
import { MountPoint } from './types';
import {
	realPathToResourceUrl,
	ensureLongPathPrefix,
	isReservedWindowsFilename,
	translateFsError,
} from './OSHelpers';

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

	constructor(
		original: unknown,
		pathMapper: PathMapper,
		security: SecurityManager,
		dryRun = false,
	) {
		this.original = original;
		this.pathMapper = pathMapper;
		this.security = security;
		this.dryRun = dryRun;
	}

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

	// ------------------------------------------------------------------
	// Security helpers
	// ------------------------------------------------------------------

	private assertAllowed(realPath: string): void {
		if (!this.security.isAllowed(realPath)) {
			throw new Error(
				`FolderBridge: "${realPath}" is not on the allowlist. ` +
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
				`FolderBridge: "${base}" is a reserved device name on Windows and ` +
				`cannot be used as a file or folder name (e.g. CON, NUL, COM1-9, LPT1-9).`
			);
		}
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
			const realPath = this.toReal(normalizedPath, mount);
			try {
				const s = await fs.promises.stat(realPath);
				return {
					type: s.isDirectory() ? 'folder' : 'file',
					ctime: s.ctimeMs,
					mtime: s.mtimeMs,
					size: s.size,
				};
			} catch {
				return null;
			}
		}
		return this.orig().stat(normalizedPath);
	}

	// ------------------------------------------------------------------
	// list
	// ------------------------------------------------------------------

	async list(normalizedPath: string): Promise<{ files: string[]; folders: string[] }> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			const realPath = this.toReal(normalizedPath, mount);
			return this.listRealDirectory(realPath, normalizedPath);
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
	): Promise<{ files: string[]; folders: string[] }> {
		const files: string[] = [];
		const folders: string[] = [];

		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(realDirPath, { withFileTypes: true });
		} catch (e) {
			const msg = translateFsError(e as NodeJS.ErrnoException, 'list');
			throw new Error(`FolderBridge: Cannot list "${realDirPath}": ${msg}`);
		}

		for (const entry of entries) {
			const virtualChild = virtualParentPath
				? normalizePath(virtualParentPath + '/' + entry.name)
				: entry.name;

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

		return { files, folders };
	}

	// ------------------------------------------------------------------
	// read / readBinary
	// ------------------------------------------------------------------

	async read(normalizedPath: string): Promise<string> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			const realPath = this.toReal(normalizedPath, mount);
			this.assertAllowed(realPath);
			try {
				return await fs.promises.readFile(realPath, 'utf8');
			} catch (e) {
				throw new Error(`FolderBridge: ${translateFsError(e as NodeJS.ErrnoException, 'read')}`);
			}
		}
		return this.orig().read(normalizedPath);
	}

	async readBinary(normalizedPath: string): Promise<ArrayBuffer> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			const realPath = this.toReal(normalizedPath, mount);
			this.assertAllowed(realPath);
			try {
				const buf = await fs.promises.readFile(realPath);
				// Return a proper ArrayBuffer (buf.buffer may be a shared Buffer pool slice)
				return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
			} catch (e) {
				throw new Error(`FolderBridge: ${translateFsError(e as NodeJS.ErrnoException, 'readBinary')}`);
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
			if (mount.readOnly) throw new Error(`FolderBridge: Mount "${mount.virtualPath}" is read-only.`);
			const realPath = this.toReal(normalizedPath, mount);
			this.assertAllowed(realPath);
			this.assertNotReserved(realPath);
			if (this.dryRun) { console.log(`[FolderBridge DryRun] write → ${realPath}`); return; }
			try {
				await fs.promises.mkdir(path.dirname(realPath), { recursive: true });
				return await fs.promises.writeFile(realPath, data, 'utf8');
			} catch (e) {
				throw new Error(`FolderBridge: ${translateFsError(e as NodeJS.ErrnoException, 'write')}`);
			}
		}
		return this.orig().write(normalizedPath, data, options);
	}

	async writeBinary(normalizedPath: string, data: ArrayBuffer, options?: unknown): Promise<void> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) throw new Error(`FolderBridge: Mount "${mount.virtualPath}" is read-only.`);
			const realPath = this.toReal(normalizedPath, mount);
			this.assertAllowed(realPath);
			this.assertNotReserved(realPath);
			if (this.dryRun) { console.log(`[FolderBridge DryRun] writeBinary → ${realPath}`); return; }
			try {
				await fs.promises.mkdir(path.dirname(realPath), { recursive: true });
				return await fs.promises.writeFile(realPath, Buffer.from(data));
			} catch (e) {
				throw new Error(`FolderBridge: ${translateFsError(e as NodeJS.ErrnoException, 'writeBinary')}`);
			}
		}
		return this.orig().writeBinary(normalizedPath, data, options);
	}

	async append(normalizedPath: string, data: string, options?: unknown): Promise<void> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) throw new Error(`FolderBridge: Mount "${mount.virtualPath}" is read-only.`);
			const realPath = this.toReal(normalizedPath, mount);
			this.assertAllowed(realPath);
			if (this.dryRun) { console.log(`[FolderBridge DryRun] append → ${realPath}`); return; }
			try {
				return await fs.promises.appendFile(realPath, data, 'utf8');
			} catch (e) {
				throw new Error(`FolderBridge: ${translateFsError(e as NodeJS.ErrnoException, 'append')}`);
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
			// Use the raw real path (no long-path prefix) since this becomes a URL
			return realPathToResourceUrl(this.pathMapper.toRealPath(normalizedPath, mount));
		}
		return this.orig().getResourcePath(normalizedPath);
	}

	// ------------------------------------------------------------------
	// mkdir
	// ------------------------------------------------------------------

	async mkdir(normalizedPath: string): Promise<void> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) throw new Error(`FolderBridge: Mount "${mount.virtualPath}" is read-only.`);
			const realPath = this.toReal(normalizedPath, mount);
			this.assertAllowed(realPath);
			this.assertNotReserved(realPath);
			if (this.dryRun) { console.log(`[FolderBridge DryRun] mkdir → ${realPath}`); return; }
			try {
				await fs.promises.mkdir(realPath, { recursive: true });
			} catch (e) {
				throw new Error(`FolderBridge: ${translateFsError(e as NodeJS.ErrnoException, 'mkdir')}`);
			}
			return;
		}
		return this.orig().mkdir(normalizedPath);
	}

	// ------------------------------------------------------------------
	// trash
	// ------------------------------------------------------------------

	async trashSystem(normalizedPath: string): Promise<boolean> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) throw new Error(`FolderBridge: Mount "${mount.virtualPath}" is read-only.`);
			const realPath = this.toReal(normalizedPath, mount);
			this.assertAllowed(realPath);
			if (this.dryRun) { console.log(`[FolderBridge DryRun] trashSystem → ${realPath}`); return true; }
			try {
				// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
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
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) throw new Error(`FolderBridge: Mount "${mount.virtualPath}" is read-only.`);
			const realPath = this.toReal(normalizedPath, mount);
			this.assertAllowed(realPath);
			if (this.dryRun) { console.log(`[FolderBridge DryRun] trashLocal → ${realPath}`); return; }
			await fs.promises.rm(realPath, { recursive: true, force: true });
			return;
		}
		return this.orig().trashLocal(normalizedPath, system);
	}

	// ------------------------------------------------------------------
	// rename / copy
	// ------------------------------------------------------------------

	async rename(normalizedPath: string, newNormalizedPath: string): Promise<void> {
		const srcMount = this.pathMapper.getMountForPath(normalizedPath);
		const dstMount = this.pathMapper.getMountForPath(newNormalizedPath);

		if (!srcMount && !dstMount) {
			return this.orig().rename(normalizedPath, newNormalizedPath);
		}

		if (srcMount && dstMount && srcMount.id === dstMount.id) {
			// Rename within the same mount
			if (srcMount.readOnly) throw new Error(`FolderBridge: Mount "${srcMount.virtualPath}" is read-only.`);
			const srcReal = this.toReal(normalizedPath, srcMount);
			const dstReal = this.toReal(newNormalizedPath, dstMount);
			this.assertAllowed(srcReal);
			this.assertAllowed(dstReal);
			this.assertNotReserved(dstReal);
			if (this.dryRun) { console.log(`[FolderBridge DryRun] rename ${srcReal} → ${dstReal}`); return; }
			await fs.promises.mkdir(path.dirname(dstReal), { recursive: true });
			try {
				await fs.promises.rename(srcReal, dstReal);
			} catch (e) {
				const err = e as NodeJS.ErrnoException;
				if (err.code === 'EXDEV') {
					// Cross-device move (e.g. different drive letters on Windows):
					// fall back to copy-then-delete so the operation succeeds transparently.
					await fs.promises.copyFile(srcReal, dstReal);
					await fs.promises.rm(srcReal, { recursive: true });
					return;
				}
				throw new Error(`FolderBridge: ${translateFsError(err, 'rename')}`);
			}
			return;
		}

		// Cross-mount or cross-adapter rename is not atomic – surface a clear error
		throw new Error(
			`FolderBridge: Cannot move "${normalizedPath}" to "${newNormalizedPath}" across mount boundaries. ` +
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
			throw new Error(`FolderBridge: Mount "${dstMount.virtualPath}" is read-only.`);
		}

		if (this.dryRun) {
			const srcDesc = srcMount ? this.pathMapper.toRealPath(normalizedPath, srcMount) : normalizedPath;
			const dstDesc = dstMount ? this.pathMapper.toRealPath(newNormalizedPath, dstMount) : newNormalizedPath;
			console.log(`[FolderBridge DryRun] copy ${srcDesc} → ${dstDesc}`);
			return;
		}

		try {
			// Read from source
			const content: Buffer = srcMount
				? await fs.promises.readFile(this.toReal(normalizedPath, srcMount))
				: Buffer.from(await this.orig().read(normalizedPath) as string, 'utf8');

			// Write to destination
			if (dstMount) {
				const dstReal = this.toReal(newNormalizedPath, dstMount);
				this.assertAllowed(dstReal);
				this.assertNotReserved(dstReal);
				await fs.promises.mkdir(path.dirname(dstReal), { recursive: true });
				await fs.promises.writeFile(dstReal, content);
			} else {
				await this.orig().write(newNormalizedPath, content.toString('utf8'));
			}
		} catch (e) {
			// Re-throw FolderBridge errors unchanged; translate raw fs errors
			const err = e as Error;
			if (err.message.startsWith('FolderBridge:')) throw err;
			throw new Error(`FolderBridge: ${translateFsError(e as NodeJS.ErrnoException, 'copy')}`);
		}
	}
}
