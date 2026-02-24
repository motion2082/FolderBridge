/**
 * A single virtual mount point: maps a vault-relative virtual path
 * to an absolute real filesystem path.
 */
export type MountType = 'local' | 'webdav' | 'vault' | 's3' | 'sftp';

export interface MountPoint {
	id: string;            // Unique identifier (generated at creation)
	virtualPath: string;   // Normalized vault path, e.g. "Projects/Work"
	realPath: string;      // Absolute OS path (local/vault) OR server-relative path (webdav/sftp) OR S3 prefix (s3)
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
	// Mount type (defaults to 'local' when absent)
	mountType?: MountType;
	// WebDAV-specific (only set when mountType === 'webdav')
	webdavUrl?: string;               // WebDAV server root URL, e.g. "https://mycloud.com/dav"
	webdavUsername?: string;          // Basic-auth username
	/**
	 * Encrypted password blob produced by encryptCredential().
	 * Stored in data.json but device-specific: the OS keychain is the encryption
	 * key, so the value is useless on any other device even if data.json syncs.
	 * Format: "enc:<base64-of-safeStorage-encrypted-buffer>"
	 */
	encryptedWebdavPassword?: string;
	/** TRANSIENT — never written to data.json.  Carries the password from the
	 *  modal → addMount() / updateMount() so it can be saved to sessionStorage
	 *  under the real (server-assigned) mount id. */
	webdavPassword?: string;

	// S3 / Backblaze B2-specific (only set when mountType === 's3')
	/** S3 bucket name */
	s3Bucket?: string;
	/** AWS region, e.g. "us-east-1". Required for AWS; for B2 use the bucket's region string. */
	s3Region?: string;
	/** Custom S3 endpoint URL. Leave empty for AWS; set to B2 S3-compat endpoint for Backblaze. */
	s3Endpoint?: string;
	/** S3 access key ID (IAM key or B2 application key ID). */
	s3AccessKeyId?: string;
	/** Encrypted S3 secret access key (produced by encryptCredential). */
	encryptedS3SecretKey?: string;
	/** TRANSIENT — carries the raw secret key from the modal to addMount(). Never persisted. */
	s3SecretKey?: string;
	/** Force path-style addressing (required for Backblaze B2 and many self-hosted S3 servers). */
	s3ForcePathStyle?: boolean;

	// SFTP-specific (only set when mountType === 'sftp')
	/** SFTP server hostname or IP address */
	sftpHost?: string;
	/** SFTP port (default 22) */
	sftpPort?: number;
	/** SFTP username */
	sftpUsername?: string;
	/** Encrypted SFTP password (produced by encryptCredential). */
	encryptedSftpPassword?: string;
	/** TRANSIENT — carries the raw password from the modal to addMount(). Never persisted. */
	sftpPassword?: string;
	/** Path to a local private key file for key-based authentication (desktop only). */
	sftpPrivateKeyPath?: string;
	/** Encrypted passphrase for the private key (produced by encryptCredential). */
	encryptedSftpPassphrase?: string;
	/** TRANSIENT — carries the raw passphrase from the modal. Never persisted. */
	sftpPassphrase?: string;
}

export interface FolderBridgeSettings {
	mountPoints: MountPoint[];
	allowlist: string[];    // Approved real paths (must match before any I/O)
	dryRun: boolean;        // Log writes without executing them
	showStatusBar: boolean;
	mountRootDeletionBehavior: 'ask' | 'unmount' | 'delete';
	deviceId: string;       // Unique ID for this specific device
	allowForeignMounts: boolean; // Allow mounting paths created on other devices
	/** Maximum size (in MB) of files that will be served as data: URIs (images, PDFs). */
	maxDataUriMB: number;
	/**
	 * Patterns applied to EVERY mount, exactly like per-mount ignoreList entries.
	 * Useful for OS noise files: .DS_Store, Thumbs.db, desktop.ini, etc.
	 */
	globalIgnorePatterns: string[];
	/** Set to true after the first-run welcome modal has been shown. */
	hasSeenOnboarding: boolean;
}

export const DEFAULT_SETTINGS: FolderBridgeSettings = {
	mountPoints: [],
	allowlist: [],
	dryRun: false,
	showStatusBar: true,
	mountRootDeletionBehavior: 'ask',
	deviceId: '',
	allowForeignMounts: false,
	maxDataUriMB: 10,
	globalIgnorePatterns: ['.DS_Store', 'Thumbs.db', 'desktop.ini', '.git'],
	hasSeenOnboarding: false,
};

export interface MountStatus {
	mount: MountPoint;
	reachable: boolean;
	readOnly: boolean;     // true if OS-level or mount-level read-only
	error?: string;
}

export type OSPlatform = 'windows' | 'linux' | 'mac' | 'unknown';
