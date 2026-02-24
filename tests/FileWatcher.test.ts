import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { App } from 'obsidian';
import { FileWatcher } from '../src/FileWatcher';
import { PathMapper } from '../src/PathMapper';
import type { MountPoint } from '../src/types';

// ── Chokidar mock ─────────────────────────────────────────────────────────────
// We patch FileWatcher._loadChokidar (a static property) so tests never call
// the real require('chokidar') and don't need vi.mock().
const on = vi.fn();
const close = vi.fn();
const mockWatcherInstance = { on, close } as unknown as import('chokidar').FSWatcher;
on.mockReturnValue(mockWatcherInstance); // make .on() chainable
const mockChokidarWatch = vi.fn(() => mockWatcherInstance);
const mockWatcherOn = on;
const mockWatcherClose = close;

// Install the mock before any describe blocks run
FileWatcher._loadChokidar = () => ({ watch: mockChokidarWatch } as unknown as typeof import('chokidar'));

// ── Helpers ───────────────────────────────────────────────────────────────────

function mkMount(id: string, virtualPath: string, realPath: string): MountPoint {
    return { id, virtualPath, realPath, enabled: true, readOnly: false };
}

function makeApp() {
    const mockOnChange = vi.fn().mockResolvedValue(undefined);
    const mockGetAbstractFileByPath = vi.fn(() => null as unknown);
    const mockStat = vi.fn().mockResolvedValue({ size: 100, ctime: 0, mtime: Date.now() });
    const app = {
        vault: {
            onChange: mockOnChange,
            getAbstractFileByPath: mockGetAbstractFileByPath,
            adapter: { stat: mockStat },
        },
    } as unknown as App;
    return { app, mockOnChange, mockGetAbstractFileByPath, mockStat };
}

function makeMapper(mount: MountPoint): PathMapper {
    const mapper = new PathMapper();
    mapper.update([mount], 'test-device');
    return mapper;
}

/** Return the callback registered on the mock watcher for a given chokidar event. */
function getCallback(eventName: string): ((...args: unknown[]) => Promise<void>) {
    const call = mockWatcherOn.mock.calls.find(c => c[0] === eventName);
    if (!call) throw new Error(`No chokidar handler for '${eventName}'`);
    return call[1] as ((...args: unknown[]) => Promise<void>);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FileWatcher', () => {
    const mount = mkMount('m1', 'mounts/docs', 'C:/Users/test/Documents');

    beforeEach(() => {
        mockChokidarWatch.mockClear();
        mockWatcherOn.mockClear();
        mockWatcherClose.mockClear();
        mockWatcherOn.mockReturnValue(mockWatcherInstance); // re-establish chaining
    });

    // ── startWatching ──────────────────────────────────────────────────────────

    describe('startWatching', () => {
        it('calls chokidar.watch with the mount real path and required options', () => {
            const { app } = makeApp();
            const fw = new FileWatcher(app, makeMapper(mount), () => false);

            fw.startWatching(mount);

            expect(mockChokidarWatch).toHaveBeenCalledWith(
                'C:/Users/test/Documents',
                expect.objectContaining({
                    followSymlinks: false,
                    ignoreInitial: true,
                    persistent: true,
                })
            );
        });

        it('registers add, change, unlink, addDir, unlinkDir and error handlers', () => {
            const { app } = makeApp();
            const fw = new FileWatcher(app, makeMapper(mount), () => false);

            fw.startWatching(mount);

            const events = mockWatcherOn.mock.calls.map(c => c[0]);
            expect(events).toContain('add');
            expect(events).toContain('change');
            expect(events).toContain('unlink');
            expect(events).toContain('addDir');
            expect(events).toContain('unlinkDir');
            expect(events).toContain('error');
        });

        it('stops the existing watcher before starting a new one for the same mount', () => {
            const { app } = makeApp();
            const fw = new FileWatcher(app, makeMapper(mount), () => false);

            fw.startWatching(mount);
            fw.startWatching(mount); // second call should close the first

            expect(mockWatcherClose).toHaveBeenCalledTimes(1);
            expect(mockChokidarWatch).toHaveBeenCalledTimes(2);
        });
    });

    // ── stopWatching ───────────────────────────────────────────────────────────

    describe('stopWatching', () => {
        it('closes the watcher for the given mount', () => {
            const { app } = makeApp();
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            fw.stopWatching(mount);

            expect(mockWatcherClose).toHaveBeenCalledTimes(1);
        });

        it('is a no-op if the mount is not being watched', () => {
            const { app } = makeApp();
            const fw = new FileWatcher(app, makeMapper(mount), () => false);

            fw.stopWatching(mount);

            expect(mockWatcherClose).not.toHaveBeenCalled();
        });
    });

    // ── stopAll ────────────────────────────────────────────────────────────────

    describe('stopAll', () => {
        it('closes all active watchers', () => {
            const mount2 = mkMount('m2', 'mounts/photos', 'C:/Users/test/Photos');
            const { app } = makeApp();
            const mapper = new PathMapper();
            mapper.update([mount, mount2], 'test-device');
            const fw = new FileWatcher(app, mapper, () => false);

            fw.startWatching(mount);
            fw.startWatching(mount2);
            mockWatcherClose.mockClear();

            fw.stopAll();

            expect(mockWatcherClose).toHaveBeenCalledTimes(2);
        });
    });

    // ── ignored callback ───────────────────────────────────────────────────────

    describe('ignored callback', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        function getIgnored(): (p: string) => boolean {
            const { app } = makeApp();
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const options = (mockChokidarWatch.mock.calls as any)[0][1] as Record<string, unknown>;
            return options.ignored as (p: string) => boolean;
        }

        it('ignores hidden files (name starts with .)', () => {
            const ignored = getIgnored();
            expect(ignored('C:/Users/test/Documents/.git')).toBe(true);
            expect(ignored('C:/Users/test/Documents/.DS_Store')).toBe(true);
        });

        it('ignores node_modules', () => {
            const ignored = getIgnored();
            expect(ignored('C:/Users/test/Documents/node_modules')).toBe(true);
        });

        it('does not ignore regular files', () => {
            const ignored = getIgnored();
            expect(ignored('C:/Users/test/Documents/readme.md')).toBe(false);
            expect(ignored('C:/Users/test/Documents/images/photo.jpg')).toBe(false);
        });

        it('applies user-defined ignore rules via isIgnored callback', () => {
            const { app } = makeApp();
            const isIgnored = vi.fn((name: string) => name === 'secret.md');
            const fw = new FileWatcher(app, makeMapper(mount), isIgnored);
            fw.startWatching(mount);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const options = (mockChokidarWatch.mock.calls as any)[0][1] as Record<string, unknown>;
            const ignored = options.ignored as (p: string) => boolean;

            expect(ignored('C:/Users/test/Documents/secret.md')).toBe(true);
            expect(ignored('C:/Users/test/Documents/notes.md')).toBe(false);
        });
    });

    // ── handleEvent (via chokidar callbacks) ──────────────────────────────────

    describe('handleEvent via chokidar callbacks', () => {
        it('file-created: calls vault.onChange with stat when file is new', async () => {
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue(null);
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            await getCallback('add')('C:/Users/test/Documents/note.md');

            expect(mockOnChange).toHaveBeenCalledWith('file-created', 'mounts/docs/note.md', null, expect.any(Object));
        });

        it('file-created: skips when file already exists in vault', async () => {
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue({ path: 'mounts/docs/note.md' });
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            await getCallback('add')('C:/Users/test/Documents/note.md');

            expect(mockOnChange).not.toHaveBeenCalled();
        });

        it('file-changed: calls vault.onChange with stat then raw', async () => {
            vi.useFakeTimers();
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue({ path: 'mounts/docs/note.md' });
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            // handleEvent is synchronous — must advance timers to trigger dispatchEvent
            (getCallback('change') as (p: string) => void)('C:/Users/test/Documents/note.md');
            await vi.runAllTimersAsync();

            expect(mockOnChange).toHaveBeenCalledWith('file-changed', 'mounts/docs/note.md', null, expect.any(Object));
            expect(mockOnChange).toHaveBeenCalledWith('raw', 'mounts/docs/note.md', null, null);
            vi.useRealTimers();
        });

        it('file-changed: skips when file is not in vault', async () => {
            vi.useFakeTimers();
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue(null);
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            (getCallback('change') as (p: string) => void)('C:/Users/test/Documents/note.md');
            await vi.runAllTimersAsync();

            expect(mockOnChange).not.toHaveBeenCalled();
            vi.useRealTimers();
        });

        it('file-changed: debounces rapid writes — only notifies vault once', async () => {
            vi.useFakeTimers();
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue({ path: 'mounts/docs/note.md' });
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            const changeCb = getCallback('change') as (p: string) => void;
            changeCb('C:/Users/test/Documents/note.md');
            changeCb('C:/Users/test/Documents/note.md');
            changeCb('C:/Users/test/Documents/note.md');
            await vi.runAllTimersAsync();

            // Three rapid writes → one file-changed + one raw
            expect(mockOnChange).toHaveBeenCalledTimes(2);
            expect(mockOnChange).toHaveBeenCalledWith('file-changed', 'mounts/docs/note.md', null, expect.any(Object));
            vi.useRealTimers();
        });

        it('file-changed: resets timer on each write (trailing-edge debounce)', async () => {
            vi.useFakeTimers();
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue({ path: 'mounts/docs/note.md' });
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            const changeCb = getCallback('change') as (p: string) => void;
            changeCb('C:/Users/test/Documents/note.md');
            await vi.advanceTimersByTimeAsync(100); // before DEBOUNCE_MS
            expect(mockOnChange).not.toHaveBeenCalled();

            changeCb('C:/Users/test/Documents/note.md'); // resets the 300ms timer
            await vi.advanceTimersByTimeAsync(299);
            expect(mockOnChange).not.toHaveBeenCalled(); // still inside new window

            await vi.runAllTimersAsync(); // now past DEBOUNCE_MS
            expect(mockOnChange).toHaveBeenCalledWith('file-changed', 'mounts/docs/note.md', null, expect.any(Object));
            vi.useRealTimers();
        });

        it('file-changed: separate paths debounce independently', async () => {
            vi.useFakeTimers();
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue({ path: 'mounts/docs/a.md' });
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            const changeCb = getCallback('change') as (p: string) => void;
            changeCb('C:/Users/test/Documents/a.md');
            changeCb('C:/Users/test/Documents/b.md');
            await vi.runAllTimersAsync();

            // Two different paths → two independent debounce timers → 4 onChange calls
            expect(mockOnChange).toHaveBeenCalledTimes(4); // (file-changed + raw) × 2
            vi.useRealTimers();
        });

        it('file-removed: calls vault.onChange without stat', async () => {
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue({ path: 'mounts/docs/note.md' });
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            await getCallback('unlink')('C:/Users/test/Documents/note.md');

            expect(mockOnChange).toHaveBeenCalledWith('file-removed', 'mounts/docs/note.md', null, null);
        });

        it('file-removed: skips when file is not in vault', async () => {
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue(null);
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            await getCallback('unlink')('C:/Users/test/Documents/note.md');

            expect(mockOnChange).not.toHaveBeenCalled();
        });

        it('folder-created: calls vault.onChange without stat', async () => {
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue(null);
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            await getCallback('addDir')('C:/Users/test/Documents/subfolder');

            expect(mockOnChange).toHaveBeenCalledWith('folder-created', 'mounts/docs/subfolder', null, null);
        });

        it('folder-removed: calls vault.onChange without stat', async () => {
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue({ path: 'mounts/docs/subfolder' });
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            await getCallback('unlinkDir')('C:/Users/test/Documents/subfolder');

            expect(mockOnChange).toHaveBeenCalledWith('folder-removed', 'mounts/docs/subfolder', null, null);
        });

        it('file-created: skips vault.onChange when stat() returns null', async () => {
            const { app, mockOnChange, mockGetAbstractFileByPath, mockStat } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue(null);
            mockStat.mockResolvedValue(null);
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            await getCallback('add')('C:/Users/test/Documents/note.md');

            expect(mockOnChange).not.toHaveBeenCalled();
        });

        it('does not throw when vault.onChange is not a function', async () => {
            const app = {
                vault: {
                    onChange: null,
                    getAbstractFileByPath: vi.fn(() => null),
                    adapter: { stat: vi.fn().mockResolvedValue({ size: 0, ctime: 0, mtime: 0 }) },
                },
            } as unknown as App;
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            // handleEvent is synchronous (void); dispatchEvent runs async internally.
            // Verify no synchronous exception is thrown when vault.onChange is null.
            expect(() => getCallback('add')('C:/Users/test/Documents/note.md')).not.toThrow();
        });
    });
});