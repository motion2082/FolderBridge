import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PathMapper } from '../src/PathMapper';
import { SecurityManager } from '../src/SecurityManager';
import { VirtualAdapter } from '../src/VirtualAdapter';
import type { MountPoint } from '../src/types';

function makeMount(realPath: string): MountPoint {
    return {
        id: 'mount-1',
        virtualPath: 'Mounted',
        realPath,
        enabled: true,
        readOnly: false,
    };
}

describe('VirtualAdapter delete notifications', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
    });

    it('notifies mounted file removals after delete succeeds', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'folderbridge-va-'));
        tempDirs.push(tempDir);

        const mount = makeMount(tempDir);
        const mapper = new PathMapper();
        mapper.update([mount], 'test-device');
        const security = new SecurityManager([tempDir]);
        const onDelete = vi.fn().mockResolvedValue(undefined);
        const adapter = new VirtualAdapter(
            {},
            mapper,
            security,
            false,
            10 * 1024 * 1024,
            async () => 'delete',
            async () => { },
            () => false,
            undefined,
            onDelete,
        );

        const normalizedPath = 'Mounted/note.md';
        await fs.writeFile(path.join(tempDir, 'note.md'), '# test');

        await adapter.remove(normalizedPath);

        expect(onDelete).toHaveBeenCalledWith(normalizedPath);
        await expect(fs.stat(path.join(tempDir, 'note.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
