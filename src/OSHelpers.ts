import * as fs from 'fs';
import * as path from 'path';
import { OSPlatform } from './types';

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

export function getPlatform(): OSPlatform {
	switch (process.platform) {
		case 'win32': return 'windows';
		case 'linux': return 'linux';
		case 'darwin': return 'mac';
		default: return 'unknown';
	}
}

// ---------------------------------------------------------------------------
// Accessibility checks
// ---------------------------------------------------------------------------

export interface PathAccessResult {
	accessible: boolean;
	readOnly: boolean;
	error?: string;
}

/**
 * Check whether a real filesystem path is accessible, and if so whether it
 * is writable.  Safe to call on non-existent paths (returns accessible:false).
 */
export async function checkPathAccessible(realPath: string): Promise<PathAccessResult> {
	try {
		await fs.promises.access(realPath, fs.constants.F_OK);
	} catch (e) {
		return { accessible: false, readOnly: false, error: (e as Error).message };
	}

	let readOnly = false;
	try {
		await fs.promises.access(realPath, fs.constants.W_OK);
	} catch {
		readOnly = true;
	}

	return { accessible: true, readOnly };
}

/** Returns true when realPath exists and is a directory (resolving symlinks). */
export async function isDirectory(realPath: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(realPath)).isDirectory();
	} catch {
		return false;
	}
}

/** Returns true when realPath is a symbolic link (does NOT follow it). */
export async function isSymlink(realPath: string): Promise<boolean> {
	try {
		return (await fs.promises.lstat(realPath)).isSymbolicLink();
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Windows-specific helpers
// ---------------------------------------------------------------------------

/**
 * On Windows, detect whether a directory entry is a junction or symlink by
 * checking the lstat result.  Both are reported as symbolic links by Node.js
 * on Windows with a non-zero nlink count for junctions.
 *
 * Always returns false on non-Windows platforms.
 */
export async function isWindowsJunctionOrSymlink(realPath: string): Promise<boolean> {
	if (getPlatform() !== 'windows') return false;
	try {
		return (await fs.promises.lstat(realPath)).isSymbolicLink();
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Cross-device detection
// ---------------------------------------------------------------------------

/**
 * Returns true when pathA and pathB reside on different filesystem devices.
 * This is used to warn the user before attempting a cross-device move, which
 * requires a copy-then-delete rather than a simple rename.
 */
export async function areDifferentDevices(pathA: string, pathB: string): Promise<boolean> {
	try {
		const [statA, statB] = await Promise.all([
			fs.promises.stat(pathA).catch(() => null),
			fs.promises.stat(pathB).catch(() => null),
		]);
		if (!statA || !statB) return false;
		return (statA as fs.Stats & { dev: number }).dev !== (statB as fs.Stats & { dev: number }).dev;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

/** Normalize a real OS path (handles mixed separators on Windows). */
export function normalizeRealPath(realPath: string): string {
	return path.normalize(realPath);
}

/**
 * Return a resource URL that Obsidian/Electron can use to display a file
 * from an arbitrary real path (e.g. for images embedded from mounted folders).
 *
 * The "app://local/" protocol is served by the Electron main process and
 * bypasses the vault root restriction.
 */
export function realPathToResourceUrl(realPath: string): string {
	// Obsidian provides a built-in way to convert a file path to a resource URL
	// that handles all the platform-specific quirks (like app://local vs capacitor://localhost)
	// and proper URL encoding.
	// We can access it via the global app object if it's available.

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const globalApp = (window as any).app;
	if (globalApp && typeof globalApp.vault.adapter.getResourcePath === 'function') {
		// We can't pass the real path to getResourcePath because it expects a vault-relative path.
		// But we can use the internal file URL conversion if we can find it.
	}

	// Fallback manual implementation
	// Electron expects forward slashes even on Windows
	const forward = realPath.split(path.sep).join('/');

	// For Windows paths like D:\path, we need to ensure it starts with a slash
	// so it becomes /D:/path, which then becomes app://local/D:/path
	const withSlash = forward.startsWith('/') ? forward : '/' + forward;

	// Obsidian 1.5+ uses app://local/ for local files, but requires proper URL encoding
	// for spaces and special characters in the path.
	// We don't encode the drive letter colon (e.g. D:)
	const encodedPath = withSlash.split('/').map(segment => {
		if (segment.match(/^[a-zA-Z]:$/)) return segment;
		return encodeURIComponent(segment);
	}).join('/');

	// Obsidian's app://local protocol requires the path to be prefixed with the drive letter
	// but without the colon, or with a specific format depending on the OS.
	// Actually, the issue is that Obsidian's app://local protocol expects the path to be 
	// exactly as it would be in a file:// URL, but with app://local instead.
	// On Windows, this means it needs an extra slash at the beginning: app://local/D:/...
	// Let's ensure it has exactly one slash before the drive letter.

	const finalPath = encodedPath.startsWith('/') ? encodedPath : '/' + encodedPath;

	// Remove the console.log to clean up the console
	return `app://local${finalPath}`;
}

// ---------------------------------------------------------------------------
// Windows path utilities
// ---------------------------------------------------------------------------

/**
 * Normalize a path for equality comparison.  On Windows (case-insensitive
 * NTFS) this lowercases the result so that 'C:\Docs' and 'c:\docs' are
 * treated as the same path.  On POSIX systems the case is preserved.
 */
export function normalizeForComparison(p: string): string {
	const n = path.normalize(p);
	return getPlatform() === 'windows' ? n.toLowerCase() : n;
}

/**
 * Returns true for UNC network paths (e.g. `\\server\share`).
 * These start with two backslashes and indicate a network location.
 */
export function isUNCPath(p: string): boolean {
	return p.startsWith('\\\\');
}

/**
 * On Windows, paths longer than 260 characters (MAX_PATH) silently fail
 * unless the path is prefixed with `\\?\` (or `\\?\UNC\` for UNC paths).
 * This helper applies the prefix when needed.  It is a no-op on other
 * platforms, or when the path is already prefixed or short enough.
 */
export function ensureLongPathPrefix(p: string): string {
	if (getPlatform() !== 'windows') return p;
	if (p.startsWith('\\\\?\\')) return p;  // already prefixed
	if (p.length < 260) return p;            // short enough; no prefix needed
	if (isUNCPath(p)) {
		// \\server\share\... → \\?\UNC\server\share\...
		return '\\\\?\\UNC\\' + p.slice(2);
	}
	// C:\... → \\?\C:\...
	return '\\\\?\\' + p;
}

/**
 * Returns true when `name` is a Windows reserved device filename.
 * These names (CON, NUL, COM1-9, LPT1-9, etc.) cannot be used as file or
 * directory names on Windows, even with an extension (e.g. `CON.txt`).
 *
 * Always returns false on non-Windows platforms.
 */
export function isReservedWindowsFilename(name: string): boolean {
	if (getPlatform() !== 'windows') return false;
	const stem = name.split('.')[0];
	return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(stem);
}

// ---------------------------------------------------------------------------
// WSL (Windows Subsystem for Linux) helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the current process is running inside WSL (Windows
 * Subsystem for Linux).
 *
 * Detection strategy (in order):
 *  1. `WSL_DISTRO_NAME` env var — set by WSL 2 for the active distro name
 *  2. `WSLENV` env var — set by both WSL 1 and WSL 2 for shared env vars
 *  3. `/proc/version` fallback — reads the kernel version string and checks
 *     for "microsoft" or "wsl" (covers edge cases where env vars are absent)
 *
 * Always returns false on non-Linux platforms.
 */
export function isWSL(): boolean {
	if (getPlatform() !== 'linux') return false;
	if (process.env.WSL_DISTRO_NAME || process.env.WSLENV) return true;
	try {
		const version = fs.readFileSync('/proc/version', 'utf8');
		return /microsoft|wsl/i.test(version);
	} catch {
		return false;
	}
}

/**
 * Convert a WSL drive-mount path like /mnt/c/Users/foo to the equivalent
 * Windows path C:\Users\foo.
 *
 * Only single-letter drive mounts under /mnt are supported (e.g., /mnt/c,
 * /mnt/D).  Paths with multi-letter mount names such as /mnt/cc/path do
 * not match this pattern and will cause the function to return null.
 *
 * Exported for use by future UI features (e.g. auto-converting a WSL path
 * to its Windows-side UNC form when the user is setting up a cross-OS mount).
 */
export function wslMountToWindowsPath(wslPath: string): string | null {
	// Regex intentionally restricts to a single drive letter under /mnt
	// (i.e. /mnt/<drive-letter>[/...]); multi-letter mounts are treated as invalid.
	const match = wslPath.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
	if (!match) return null;
	const drive = match[1].toUpperCase();
	const rest = (match[2] ?? '').replace(/\//g, '\\');
	return `${drive}:${rest || '\\'}`;
}

// ---------------------------------------------------------------------------

/**
 * Translate a Node.js filesystem error code into a user-friendly message
 * with platform-appropriate guidance where relevant.
 */
export function translateFsError(err: NodeJS.ErrnoException, op: string): string {
	const p = err.path ? `"${err.path}"` : 'path';
	switch (err.code) {
		case 'EACCES':
			return `Access denied to ${p}. Check folder permissions.`;
		case 'EPERM':
			return getPlatform() === 'windows'
				? `Operation not permitted on ${p}. On Windows, creating symbolic links ` +
				`requires Developer Mode (Settings → System → For Developers) or administrator rights.`
				: `Operation not permitted on ${p}. Check file permissions or ownership.`;
		case 'ENAMETOOLONG':
			return getPlatform() === 'windows'
				? `Path exceeds the Windows 260-character limit. Enable Long Paths in ` +
				`Windows Settings → System → For Developers → Long Paths, or use a shorter path.`
				: `Path name is too long for the filesystem.`;
		case 'EBUSY':
			return `${p} is locked by another process. Close any programs using it and try again.`;
		case 'ENOENT':
			return `${p} was not found. It may have been moved or deleted.`;
		case 'ENOSPC':
			return `Not enough disk space to complete the operation.`;
		case 'EXDEV':
			return `Cross-device move is not supported at the OS level (handled internally by FolderBridge).`;
		default:
			return `${op}: ${err.message}`;
	}
}
