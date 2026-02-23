/**
 * A single virtual mount point: maps a vault-relative virtual path
 * to an absolute real filesystem path.
 */
export type MountType = 'local' | 'webdav';

export interface MountPoint {
	id: string;            // Unique identifier (generated at creation)
	virtualPath: string;   // Normalized vault path, e.g. "Projects/Work"
	realPath: string;      // Absolute OS path (local) OR server-relative path (webdav)
	enabled: boolean;      // Whether the mount is currently active
	readOnly: boolean;     // Block all write operations through this mount
	label?: string;        // Optional human-readable display name
	deviceId?: string;     // The device ID that created this mount (for sync compatibility)
	deviceOverrides?: Record<string, string>; // Map of deviceId -> realPath override
	ignoreList?: string[]; // List of file/folder names to ignore for this specific mount
	// Per-mount watcher settings (all optional; fall back to built-in defaults)
	watcherDebounceMs?: number;       // Debounce threshold for change events (default 300 ms)
	watcherUsePolling?: boolean;      // Use polling instead of native fs events (for NAS/network drives)
	watcherPollingIntervalMs?: number; // Polling interval in ms (default 2000; only used when usePolling)
	maxFiles?: number;                // Cap initial scan at this many files (0 = unlimited)
	// WebDAV-specific (only set when mountType === 'webdav')
	mountType?: MountType;            // 'local' (default) or 'webdav'
	webdavUrl?: string;               // WebDAV server root URL, e.g. "https://mycloud.com/dav"
	webdavUsername?: string;          // Basic-auth username (password stored in sessionStorage only)
	/** TRANSIENT — never written to data.json.  Carries the password from the
	 *  modal → addMount() / updateMount() so it can be saved to sessionStorage
	 *  under the real (server-assigned) mount id. */
	webdavPassword?: string;
}

export interface FolderBridgeSettings {
	mountPoints: MountPoint[];
	allowlist: string[];    // Approved real paths (must match before any I/O)
	dryRun: boolean;        // Log writes without executing them
	showStatusBar: boolean;
	mountRootDeletionBehavior: 'ask' | 'unmount' | 'delete';
	deviceId: string;       // Unique ID for this specific device
	allowForeignMounts: boolean; // Allow mounting paths created on other devices
}

export const DEFAULT_SETTINGS: FolderBridgeSettings = {
	mountPoints: [],
	allowlist: [],
	dryRun: false,
	showStatusBar: true,
	mountRootDeletionBehavior: 'ask',
	deviceId: '',
	allowForeignMounts: false,
};

export interface MountStatus {
	mount: MountPoint;
	reachable: boolean;
	readOnly: boolean;     // true if OS-level or mount-level read-only
	error?: string;
}

export type OSPlatform = 'windows' | 'linux' | 'mac' | 'unknown';
