import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { PathMapper, expandVaultToken, toVaultTokenPath } from '../src/PathMapper';
import type { MountPoint } from '../src/types';

function mount(virtualPath: string, realPath: string): MountPoint {
	return { id: '1', virtualPath, realPath, enabled: true, readOnly: false };
}

describe('PathMapper', () => {
	let mapper: PathMapper;

	beforeEach(() => {
		mapper = new PathMapper();
	});

	describe('getMountForPath', () => {
		it('returns undefined when no mounts are loaded', () => {
			expect(mapper.getMountForPath('foo/bar')).toBeUndefined();
		});

		it('returns the mount for an exact match', () => {
			const m = mount('Projects/Work', '/real/Work');
			mapper.update([m]);
			expect(mapper.getMountForPath('Projects/Work')).toBe(m);
		});

		it('returns the mount for a child path', () => {
			const m = mount('Projects/Work', '/real/Work');
			mapper.update([m]);
			expect(mapper.getMountForPath('Projects/Work/notes.md')).toBe(m);
		});

		it('returns undefined for a path outside all mounts', () => {
			mapper.update([mount('Projects/Work', '/real/Work')]);
			expect(mapper.getMountForPath('Documents')).toBeUndefined();
		});

		it('returns the most-specific mount when mounts overlap in specificity', () => {
			const outer = mount('Projects', '/outer');
			const inner = mount('Projects/Work', '/inner');
			mapper.update([outer, inner]);
			expect(mapper.getMountForPath('Projects/Work/file.md')).toBe(inner);
		});

		it('only considers enabled mounts', () => {
			const disabled: MountPoint = { id: '2', virtualPath: 'Disabled', realPath: '/d', enabled: false, readOnly: false };
			mapper.update([disabled]);
			expect(mapper.getMountForPath('Disabled')).toBeUndefined();
		});
	});

	describe('toRealPath', () => {
		it('returns realPath for the mount root', () => {
			const m = mount('Projects/Work', '/real/Work');
			expect(mapper.toRealPath('Projects/Work', m)).toBe('/real/Work');
		});

		it('joins relative segments correctly for a child path', () => {
			const m = mount('Projects/Work', '/real/Work');
			const result = mapper.toRealPath('Projects/Work/notes/todo.md', m);
			expect(result).toBe(path.join('/real/Work', 'notes', 'todo.md'));
		});
	});

	describe('toVirtualPath', () => {
		it('returns the virtual mount path for the real mount root', () => {
			const m = mount('Projects/Work', '/real/Work');
			expect(mapper.toVirtualPath('/real/Work', m)).toBe('Projects/Work');
		});

		it('converts a child real path to a virtual path', () => {
			const m = mount('Projects/Work', '/real/Work');
			const result = mapper.toVirtualPath(path.join('/real/Work', 'notes', 'todo.md'), m);
			expect(result).toBe('Projects/Work/notes/todo.md');
		});
	});

	describe('getVirtualMountsDirectChildren', () => {
		it('returns top-level mounts at the vault root', () => {
			mapper.update([mount('Work', '/real/Work')]);
			expect(mapper.getVirtualMountsDirectChildren('')).toContain('Work');
		});

		it('returns the first path component for a nested mount at the vault root', () => {
			mapper.update([mount('Projects/Work', '/real/Work')]);
			const children = mapper.getVirtualMountsDirectChildren('');
			expect(children).toContain('Projects');
			expect(children).not.toContain('Projects/Work');
		});

		it('returns the full mount path when listing an intermediate directory', () => {
			mapper.update([mount('Projects/Work', '/real/Work')]);
			const children = mapper.getVirtualMountsDirectChildren('Projects');
			expect(children).toContain('Projects/Work');
		});

		it('deduplicates intermediate folders for multiple nested mounts', () => {
			mapper.update([
				mount('Projects/Work', '/real/Work'),
				mount('Projects/Personal', '/real/Personal'),
			]);
			const children = mapper.getVirtualMountsDirectChildren('');
			const projectsCount = children.filter(c => c === 'Projects').length;
			expect(projectsCount).toBe(1);
		});

		it('returns direct children only, not deeply nested paths', () => {
			mapper.update([mount('A/B/C', '/real/C')]);
			const root = mapper.getVirtualMountsDirectChildren('');
			expect(root).toContain('A');
			expect(root).not.toContain('A/B');

			const levelA = mapper.getVirtualMountsDirectChildren('A');
			expect(levelA).toContain('A/B');
			expect(levelA).not.toContain('A/B/C');
		});
	});

	describe('hasMountsUnder', () => {
		it('returns false when no mounts loaded', () => {
			expect(mapper.hasMountsUnder('Projects')).toBe(false);
		});

		it('returns true for a path that has a mount under it', () => {
			mapper.update([mount('Projects/Work', '/real/Work')]);
			expect(mapper.hasMountsUnder('Projects')).toBe(true);
		});

		it('returns false for a sibling path', () => {
			mapper.update([mount('Projects/Work', '/real/Work')]);
			expect(mapper.hasMountsUnder('Documents')).toBe(false);
		});

		it('returns true for the vault root when any mount exists', () => {
			mapper.update([mount('Work', '/real/Work')]);
			expect(mapper.hasMountsUnder('')).toBe(true);
		});
	});

	describe('getEffectiveRealPath / {{vault}} token', () => {
		it('expands {{vault}} to the vault base path', () => {
			const m = mount('claude', '{{vault}}/.claude');
			mapper.update([m], 'dev1', '/home/user/Vault');
			expect(mapper.getEffectiveRealPath(m)).toBe('/home/user/Vault/.claude');
		});

		it('returns the raw path when no vault base path is known', () => {
			const m = mount('claude', '{{vault}}/.claude');
			mapper.update([m]);
			expect(mapper.getEffectiveRealPath(m)).toBe('{{vault}}/.claude');
		});

		it('does not report a {{vault}} mount as using its fallback', () => {
			const m = mount('claude', '{{vault}}/.claude');
			mapper.update([m], 'dev1', '/home/user/Vault');
			expect(mapper.isUsingFallbackPath(m.id)).toBe(false);
		});

		it('reports the fallback only after a runtime path was resolved', () => {
			const m = { ...mount('Work', '/missing/Work'), fallbackRealPath: '/real/Work' };
			mapper.update([m], 'dev1', '/home/user/Vault');
			expect(mapper.isUsingFallbackPath(m.id)).toBe(false);

			mapper.setResolvedPath(m.id, '/real/Work');
			expect(mapper.isUsingFallbackPath(m.id)).toBe(true);
			expect(mapper.getEffectiveRealPath(m)).toBe('/real/Work');

			mapper.clearResolvedPath(m.id);
			expect(mapper.isUsingFallbackPath(m.id)).toBe(false);
			expect(mapper.getEffectiveRealPath(m)).toBe('/missing/Work');
		});

		it('prefers a device override and expands {{vault}} inside it', () => {
			const m: MountPoint = {
				...mount('Work', '/primary/Work'),
				deviceOverrides: { dev1: '{{vault}}/Work' },
			};
			mapper.update([m], 'dev1', '/home/user/Vault');
			expect(mapper.getEffectiveRealPath(m)).toBe('/home/user/Vault/Work');
		});
	});

	describe('expandVaultToken (standalone)', () => {
		it('expands every occurrence of the token', () => {
			expect(expandVaultToken('{{vault}}/a/{{vault}}', '/v')).toBe('/v/a//v');
		});

		it('returns the input unchanged without a base path or token', () => {
			expect(expandVaultToken('{{vault}}/a', '')).toBe('{{vault}}/a');
			expect(expandVaultToken('/plain/path', '/v')).toBe('/plain/path');
		});
	});

	describe('toVaultTokenPath', () => {
		const base = path.resolve('/home/user/Vault');

		it('rewrites an absolute path inside the vault as {{vault}}/... with forward slashes', () => {
			const file = path.join(base, 'folderbridge.managed.json');
			expect(toVaultTokenPath(file, base)).toBe('{{vault}}/folderbridge.managed.json');
			const nested = path.join(base, '.claude', 'skills');
			expect(toVaultTokenPath(nested, base)).toBe('{{vault}}/.claude/skills');
		});

		it('round-trips through expandVaultToken', () => {
			const file = path.join(base, 'folderbridge.managed.json');
			const token = toVaultTokenPath(file, base);
			expect(path.normalize(expandVaultToken(token, base))).toBe(file);
		});

		it('leaves paths outside the vault alone', () => {
			const outside = path.resolve('/home/user/Other/toc.json');
			expect(toVaultTokenPath(outside, base)).toBe(outside);
			// Sibling folder that merely shares the vault name as a prefix
			const sibling = path.resolve('/home/user/Vault2/toc.json');
			expect(toVaultTokenPath(sibling, base)).toBe(sibling);
		});

		it('leaves the vault root, relative paths, tokenised paths and empty input alone', () => {
			expect(toVaultTokenPath(base, base)).toBe(base);
			expect(toVaultTokenPath('relative/toc.json', base)).toBe('relative/toc.json');
			expect(toVaultTokenPath('{{vault}}/toc.json', base)).toBe('{{vault}}/toc.json');
			expect(toVaultTokenPath('', base)).toBe('');
			expect(toVaultTokenPath(path.join(base, 'toc.json'), '')).toBe(path.join(base, 'toc.json'));
		});
	});

	describe('isInsideMount', () => {
		it('returns false when path is outside all mounts', () => {
			mapper.update([mount('Work', '/real/Work')]);
			expect(mapper.isInsideMount('Documents')).toBe(false);
		});

		it('returns true for the mount root itself', () => {
			mapper.update([mount('Work', '/real/Work')]);
			expect(mapper.isInsideMount('Work')).toBe(true);
		});

		it('returns true for a path inside a mount', () => {
			mapper.update([mount('Work', '/real/Work')]);
			expect(mapper.isInsideMount('Work/notes.md')).toBe(true);
		});
	});
});
