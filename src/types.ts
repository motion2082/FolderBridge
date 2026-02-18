/**
 * A single virtual mount point: maps a vault-relative virtual path
 * to an absolute real filesystem path.
 */
export interface MountPoint {
	id: string;            // Unique identifier (generated at creation)
	virtualPath: string;   // Normalized vault path, e.g. "Projects/Work"
	realPath: string;      // Absolute OS path, e.g. "/home/user/Documents/Work"
	enabled: boolean;      // Whether the mount is currently active
	readOnly: boolean;     // Block all write operations through this mount
	label?: string;        // Optional human-readable display name
}

export interface FolderBridgeSettings {
	mountPoints: MountPoint[];
	allowlist: string[];    // Approved real paths (must match before any I/O)
	dryRun: boolean;        // Log writes without executing them
	showStatusBar: boolean;
	logOperations: boolean;
}

export const DEFAULT_SETTINGS: FolderBridgeSettings = {
	mountPoints: [],
	allowlist: [],
	dryRun: false,
	showStatusBar: true,
	logOperations: false,
};

export interface MountStatus {
	mount: MountPoint;
	reachable: boolean;
	readOnly: boolean;     // true if OS-level or mount-level read-only
	error?: string;
}

export type OSPlatform = 'windows' | 'linux' | 'mac' | 'unknown';
