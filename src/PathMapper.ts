import { normalizePath } from 'obsidian';
import * as path from 'path';
import { MountPoint } from './types';

/**
 * PathMapper maintains the list of active mount points and provides
 * bidirectional translation between vault-relative virtual paths and
 * real absolute filesystem paths.
 *
 * All vault paths are "normalized" (forward slashes, no leading slash),
 * matching the format Obsidian uses internally.
 */
export class PathMapper {
	private mounts: MountPoint[] = [];

	/** Replace the active mount list (call after settings change). */
	update(mounts: MountPoint[]): void {
		this.mounts = mounts.filter(m => m.enabled);
	}

	getMounts(): MountPoint[] {
		return this.mounts;
	}

	/**
	 * Returns the mount whose virtualPath exactly matches the given path.
	 * Used to detect "this IS a mount root" checks.
	 */
	getMountByVirtualPath(virtualPath: string): MountPoint | undefined {
		const n = normalizePath(virtualPath);
		return this.mounts.find(m => normalizePath(m.virtualPath) === n);
	}

	/**
	 * Returns the mount that owns the given virtual path (the path is the
	 * mount root OR a descendant of it).  Returns undefined if the path
	 * lives entirely inside the real vault.
	 */
	getMountForPath(virtualPath: string): MountPoint | undefined {
		const n = normalizePath(virtualPath);
		// Sort by virtualPath length descending so the most-specific mount wins
		const sorted = [...this.mounts].sort(
			(a, b) => b.virtualPath.length - a.virtualPath.length
		);
		return sorted.find(m => {
			const mv = normalizePath(m.virtualPath);
			return n === mv || n.startsWith(mv + '/');
		});
	}

	/** True if virtualPath is a mount root or inside a mount. */
	isInsideMount(virtualPath: string): boolean {
		return this.getMountForPath(virtualPath) !== undefined;
	}

	/**
	 * Translate a virtual vault path to the real filesystem path using
	 * the provided mount.  The mount must be the one returned by
	 * getMountForPath() for this virtualPath.
	 */
	toRealPath(virtualPath: string, mount: MountPoint): string {
		const n = normalizePath(virtualPath);
		const mv = normalizePath(mount.virtualPath);
		if (n === mv) return mount.realPath;
		const relative = n.slice(mv.length + 1); // strip "mount/" prefix
		// On Windows path.join handles backslash; on POSIX it stays as '/'
		return path.join(mount.realPath, ...relative.split('/'));
	}

	/**
	 * Translate a real filesystem path back to a virtual vault path.
	 * Only valid if realPath is inside mount.realPath.
	 */
	toVirtualPath(realPath: string, mount: MountPoint): string {
		const rel = path.relative(mount.realPath, realPath);
		if (!rel || rel.startsWith('..')) return normalizePath(mount.virtualPath);
		return normalizePath(mount.virtualPath + '/' + rel.split(path.sep).join('/'));
	}

	/**
	 * Returns the normalized virtual paths of mounts that are DIRECT children
	 * of parentVirtualPath.  Used to inject virtual folders into vault listings.
	 *
	 * parentVirtualPath === '' means the vault root.
	 */
	getVirtualMountsDirectChildren(parentVirtualPath: string): string[] {
		const parent = parentVirtualPath === '' ? '' : normalizePath(parentVirtualPath);
		const result: string[] = [];

		for (const m of this.mounts) {
			const mv = normalizePath(m.virtualPath);
			if (parent === '') {
				// Root: include mounts with no '/' in their path
				if (!mv.includes('/')) result.push(mv);
			} else {
				// Non-root: include mounts whose virtualPath is "parent/childName"
				if (mv.startsWith(parent + '/')) {
					const remainder = mv.slice(parent.length + 1);
					if (!remainder.includes('/')) result.push(mv);
				}
			}
		}

		return result;
	}

	/**
	 * True if any active mount is the given path or a descendant/child.
	 * Used to decide whether a non-existent vault directory should
	 * "appear to exist" because it is a virtual parent of a mount.
	 */
	hasMountsUnder(virtualPath: string): boolean {
		const n = virtualPath === '' ? '' : normalizePath(virtualPath);
		return this.mounts.some(m => {
			const mv = normalizePath(m.virtualPath);
			return mv === n || mv.startsWith(n === '' ? '' : n + '/');
		});
	}
}
