import * as path from 'path';
import { MountPoint } from './types';
import { normalizeForComparison, isUNCPath } from './OSHelpers';

/**
 * SecurityManager enforces an explicit allowlist of real filesystem paths.
 * Every I/O operation on a mounted path is checked against this list before
 * proceeding.  On Windows, comparisons are case-insensitive to match NTFS
 * semantics (e.g. 'C:\Docs' and 'c:\docs' refer to the same location).
 */
export class SecurityManager {
	private allowlist: Set<string>;

	constructor(allowedPaths: string[]) {
		this.allowlist = new Set(allowedPaths.map(p => normalizeForComparison(p)));
	}

	/** Replace the entire allowlist (call after settings change). */
	setAllowlist(paths: string[]): void {
		this.allowlist = new Set(paths.map(p => normalizeForComparison(p)));
	}

	/**
	 * Returns true when realPath is equal to an allowlisted path, or is
	 * contained inside one.  The check is path-separator-aware to prevent
	 * prefix-substring false positives (e.g. "/foo" must not match "/foobar").
	 * On Windows the comparison is case-insensitive.
	 */
	isAllowed(realPath: string): boolean {
		const normalized = normalizeForComparison(realPath);
		for (const allowed of this.allowlist) {
			if (
				normalized === allowed ||
				normalized.startsWith(allowed + path.sep) ||
				// Case-insensitive comparison may produce lowercased sep; check both
				normalized.startsWith(allowed + '/')
			) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Validates a candidate mount before it is added to settings.
	 * Returns an error string on failure, or null on success.
	 */
	validateMount(
		mount: Omit<MountPoint, 'id'>,
		existingMounts: MountPoint[]
	): string | null {
		if (!mount.virtualPath || !mount.virtualPath.trim()) {
			return 'Virtual path cannot be empty.';
		}
		if (!mount.realPath || !mount.realPath.trim()) {
			return 'Real path cannot be empty.';
		}
		if (!path.isAbsolute(mount.realPath)) {
			return 'Real path must be an absolute filesystem path.';
		}

		// Block obviously dangerous root-level paths
		const dangerous = ['/', 'C:\\', 'C:/', '/etc', '/usr', '/bin', '/sbin', '/boot', '/dev', '/proc', '/sys'];
		const norm = normalizeForComparison(mount.realPath);
		for (const d of dangerous) {
			if (norm === normalizeForComparison(d)) {
				return `"${mount.realPath}" is a protected system path and cannot be mounted.`;
			}
		}

		// Reject duplicate virtual paths
		const virtualNorm = mount.virtualPath.trim();
		if (existingMounts.some(m => m.virtualPath === virtualNorm)) {
			return `Virtual path "${virtualNorm}" is already in use.`;
		}

		return null;
	}

	/**
	 * Returns non-blocking advisory warnings for a real path.
	 * Unlike validateMount(), these do not prevent the mount from being added —
	 * they are surfaced to the user as informational notices.
	 */
	getPathWarnings(realPath: string): string[] {
		const warnings: string[] = [];

		if (isUNCPath(realPath)) {
			warnings.push(
				`"${realPath}" is a UNC network path. Network mounts may be slow, ` +
				`unavailable offline, or behave differently from local folders ` +
				`(e.g. file watching may not work on some servers).`
			);
		}

		return warnings;
	}

	/** Add a path to the allowlist. */
	allow(realPath: string): void {
		this.allowlist.add(normalizeForComparison(realPath));
	}

	/** Remove a path from the allowlist. */
	revoke(realPath: string): void {
		this.allowlist.delete(normalizeForComparison(realPath));
	}

	getAllowedPaths(): string[] {
		return Array.from(this.allowlist);
	}
}
