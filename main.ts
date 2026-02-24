import { App, Plugin, PluginSettingTab, Setting, Notice, normalizePath, TFolder, TFile } from 'obsidian';
import { FolderBridgeSettings, MountPoint, DEFAULT_SETTINGS } from './src/types';
import { PathMapper } from './src/PathMapper';
import { VirtualAdapter } from './src/VirtualAdapter';
import { SecurityManager } from './src/SecurityManager';
import { MountManagerModal, getMountStatus, browseFolderOnDisk, VaultFolderPickerModal } from './src/ui/MountManagerModal';
import { MountRootDeleteModal } from './src/ui/MountRootDeleteModal';
import { WelcomeModal } from './src/ui/WelcomeModal';
import { getPlatform, realPathToResourceUrl, tryReadAsDataUri } from './src/OSHelpers';
import { encryptPassword, decryptPassword } from './src/CredentialStore';
import { FileWatcher } from './src/FileWatcher';
import { WebDAVAdapter } from './src/WebDAVAdapter';

// Lazy-loaded Node.js builtins — safe on Obsidian Mobile (Capacitor).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fs: typeof import('fs') = (() => { try { return (require as any)('fs'); } catch { return null as never; } })();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
	return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class FolderBridgePlugin extends Plugin {
	settings: FolderBridgeSettings;
	pathMapper: PathMapper;
	security: SecurityManager;
	virtualAdapter: VirtualAdapter | null = null;
	fileWatcher: FileWatcher | null = null;

	// Preserve original adapter so we can restore it on unload
	private originalAdapter: unknown = null;
	// Preserve original vault.getResourcePath so we can restore it on unload
	private originalVaultGetResourcePath: unknown = null;
	statusBarItem: HTMLElement | null = null;

	/** Tracks reachability per mount.id; populated by the 30-second health-check loop. */
	mountHealthMap = new Map<string, boolean>();
	private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

	async onload() {
		await this.loadSettings();

		this.pathMapper = new PathMapper();
		this.security = new SecurityManager(this.settings.allowlist);
		this.pathMapper.update(this.settings.mountPoints, this.settings.deviceId);

		// [FEATURE_20260222] Initialize FileWatcher
		this.fileWatcher = new FileWatcher(this.app, this.pathMapper, (name, mount) => this.isNameIgnored(name, mount));

		// Install the virtual adapter shim
		this.installVirtualAdapter();

		// Ribbon icon opens the add-mount modal
		const ribbonIconEl = this.addRibbonIcon('folder-plus', 'Folder Bridge: Add Mount', () => {
			new MountManagerModal(this.app, this.security, (mount) => this.addMount(mount)).open();
		});
		ribbonIconEl.addClass('folderbridge-ribbon-class');

		// Status bar
		if (this.settings.showStatusBar) {
			this.statusBarItem = this.addStatusBarItem();
			this.updateStatusBar();
		}

		// Settings tab
		this.addSettingTab(new FolderBridgeSettingTab(this.app, this));

		// Add a command to manually refresh mounts
		this.addCommand({
			id: 'refresh-mounts',
			name: 'Refresh all mounts',
			callback: async () => {
				for (const mount of this.settings.mountPoints.filter(m => m.enabled && (m.deviceId === this.settings.deviceId || this.settings.allowForeignMounts))) {
					await this.notifyVaultMountAdded(mount);
				}
				new Notice('Folder Bridge: Mounts refreshed');
			}
		});

		// Add context menu item to ignore files/folders
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				// Only show if the file is inside a mounted folder
				const mount = this.pathMapper.getMountForPath(file.path);
				if (!mount) return;

				// "Move mount to…" — only on the mount's own root folder
				const isMountRoot = file instanceof TFolder &&
					normalizePath(file.path) === normalizePath(mount.virtualPath) &&
					mount.deviceId === this.settings.deviceId;
				if (isMountRoot) {
					menu.addItem((item) => {
						item
							.setTitle('Move mount to\u2026')
							.setIcon('folder-input')
							.onClick(() => {
								new VaultFolderPickerModal(this.app, async (newParent) => {
									const leaf = normalizePath(mount.virtualPath).split('/').pop() || '';
									const newVirtualPath = newParent
										? normalizePath(`${newParent}/${leaf}`)
										: leaf;
									if (newVirtualPath === normalizePath(mount.virtualPath)) return;
									await this.updateMount(mount.id, { ...mount, virtualPath: newVirtualPath });
								}).open();
							});
					});
				}

				menu.addItem((item) => {
					item
						.setTitle(`Ignore "${file.name}" in Folder Bridge`)
						.setIcon('eye-off')
						.onClick(async () => {
							if (!this.isNameIgnored(file.name, mount)) {
								if (!mount.ignoreList) mount.ignoreList = [];
								mount.ignoreList.push(file.name);
								await this.saveSettings();
								new Notice(`Folder Bridge: Added "${file.name}" to ignore list for mount "${mount.virtualPath}".`);

								// Remove it from the vault view immediately
								// eslint-disable-next-line @typescript-eslint/no-explicit-any
								const vault = this.app.vault as any;
								if (typeof vault.onChange === 'function') {
									try {
										if (file instanceof TFolder) {
											await vault.onChange('folder-removed', file.path, null, null);
										} else if (file instanceof TFile) {
											await vault.onChange('file-removed', file.path, null, null);
										}
									} catch (e) {
										console.debug('Folder Bridge: Failed to remove ignored item from view', e);
									}
								}
							} else {
								new Notice(`Folder Bridge: "${file.name}" is already in the ignore list for this mount.`);
							}
						});
				});
			})
		);

		// After the workspace finishes loading, inject all enabled mounts into
		// Obsidian's internal vault file tree so they appear in the file explorer
		// without requiring a restart.
		this.app.workspace.onLayoutReady(async () => {
			// [BUGFIX_20260222] Removed debug log for resource path format

			const activeMounts = this.settings.mountPoints.filter(m => m.enabled && (m.deviceId === this.settings.deviceId || this.settings.allowForeignMounts));

			// Register WebDAV adapters for all WebDAV mounts that have a saved password
			for (const mount of activeMounts.filter(m => m.mountType === 'webdav')) {
				// Try to decrypt the persisted encrypted password into sessionStorage
				// so fromMount() can pick it up without a user prompt.
				if (mount.encryptedWebdavPassword) {
					const plain = decryptPassword(mount.encryptedWebdavPassword);
					if (plain) WebDAVAdapter.savePassword(mount.id, plain);
				}
				const adapter = WebDAVAdapter.fromMount(mount);
				if (adapter) this.virtualAdapter?.setWebDAVAdapter(mount.id, adapter);
			}

			for (const mount of activeMounts) {
				await this.notifyVaultMountAdded(mount);
			}
			// Start background reachability checks after initial mount injection
			this.startHealthChecks();

			// Show first-run welcome modal for new users
			if (!this.settings.hasSeenOnboarding) {
				this.settings.hasSeenOnboarding = true;
				await this.saveSettings();
				new WelcomeModal(
					this.app,
					() => new MountManagerModal(
						this.app,
						this.security,
						async (mount) => { await this.addMount(mount); },
					).open(),
					() => { /* dismissed */ },
				).open();
			}
		});

		console.log(`FolderBridge loaded (${getPlatform()}, ${this.settings.mountPoints.filter(m => m.enabled && (m.deviceId === this.settings.deviceId || this.settings.allowForeignMounts)).length} active mounts on this device)`);
	}

	onunload() {
		// Stop background health-check loop before watcher so no stale notices fire
		if (this.healthCheckInterval !== null) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = null;
		}
		// [FEATURE_20260222] Stop all file watchers
		this.fileWatcher?.stopAll();

		// Restore the original adapter so the vault works normally after unload
		if (this.originalAdapter) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(this.app.vault as any).adapter = this.originalAdapter;
			this.originalAdapter = null;
		}

		// Restore the original vault.getResourcePath
		if (this.originalVaultGetResourcePath) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(this.app.vault as any).getResourcePath = this.originalVaultGetResourcePath;
			this.originalVaultGetResourcePath = null;
		}
		console.log('FolderBridge unloaded');
	}

	// ------------------------------------------------------------------
	// Helpers
	// ------------------------------------------------------------------

	private ignoreCache = new Map<string, { nameStrings: string[], pathStrings: string[], regexes: RegExp[] }>();

	/** Public alias used by the settings UI to refresh after global-pattern changes. */
	updateIgnoreCachePublic() { this.updateIgnoreCache(); }

	private updateIgnoreCache() {
		this.ignoreCache.clear();

		// Pre-parse global patterns once
		const globalList = this.settings.globalIgnorePatterns || [];
		const globalNameStrings: string[] = [];
		const globalPathStrings: string[] = [];
		const globalRegexes: RegExp[] = [];
		for (const pattern of globalList) {
			if (pattern.includes('*')) {
				const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
				globalRegexes.push(new RegExp('^' + escaped.replace(/\*/g, '[^/]*') + '$'));
			} else if (pattern.includes('/')) {
				globalPathStrings.push(normalizePath(pattern));
			} else {
				globalNameStrings.push(pattern);
			}
		}

		for (const mount of this.settings.mountPoints) {
			const nameStrings: string[] = [...globalNameStrings];
			const pathStrings: string[] = [...globalPathStrings];
			const regexes: RegExp[] = [...globalRegexes];
			const list = mount.ignoreList || [];
			for (const pattern of list) {
				if (pattern.includes('*')) {
					// Use [^/]* instead of .* to prevent ReDoS from user-supplied
					// patterns like "a*b*" which would produce catastrophic backtracking
					const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
					const regexStr = '^' + escaped.replace(/\*/g, '[^/]*') + '$';
					regexes.push(new RegExp(regexStr));
				} else if (pattern.includes('/')) {
					pathStrings.push(normalizePath(pattern));
				} else {
					nameStrings.push(pattern);
				}
			}
			this.ignoreCache.set(mount.id, { nameStrings, pathStrings, regexes });
		}
	}

	/**
	 * Returns true when `name` (the leaf filename/dirname) or `mountRelativePath`
	 * (the path relative to the mount root, e.g. "assets/vendor/cache") should
	 * be excluded from the vault view and file watcher.
	 *
	 * Pattern types in ignoreList:
	 *   - No slash, no wildcard  → matched against the leaf name only
	 *     (e.g. ".git", "node_modules")
	 *   - Contains "/"           → matched as a prefix against mountRelativePath
	 *     (e.g. "assets/vendor" ignores that subtree and nothing else named "assets")
	 *   - Contains "*"           → treated as a glob matched against the leaf name
	 *     (e.g. "*.tmp", "~$*")
	 */
	isNameIgnored(name: string, mount: MountPoint, mountRelativePath?: string): boolean {
		const cache = this.ignoreCache.get(mount.id);
		if (!cache) return false;
		// Path-prefix patterns: only applicable when the full relative path is known
		if (mountRelativePath) {
			for (const pathPat of cache.pathStrings) {
				if (mountRelativePath === pathPat || mountRelativePath.startsWith(pathPat + '/')) return true;
			}
		}
		// Name patterns and globs
		if (cache.nameStrings.includes(name)) return true;
		for (const regex of cache.regexes) {
			if (regex.test(name)) return true;
		}
		return false;
	}

	// ------------------------------------------------------------------
	// Adapter installation
	// ------------------------------------------------------------------

	private installVirtualAdapter(): void {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const vault = this.app.vault as any;
		this.originalAdapter = vault.adapter;

		this.virtualAdapter = new VirtualAdapter(
			this.originalAdapter,
			this.pathMapper,
			this.security,
			this.settings.dryRun,
			(this.settings.maxDataUriMB ?? 10) * 1024 * 1024,
			async (mount: MountPoint) => {
				let action: 'unmount' | 'delete' | 'cancel' = 'cancel';

				if (this.settings.mountRootDeletionBehavior === 'unmount') {
					action = 'unmount';
				} else if (this.settings.mountRootDeletionBehavior === 'delete') {
					action = 'delete';
				} else {
					action = await new Promise<'unmount' | 'delete' | 'cancel'>((resolve) => {
						const modal = new MountRootDeleteModal(this.app, mount.virtualPath, async (result) => {
							if (result === 'unmount-always') {
								this.settings.mountRootDeletionBehavior = 'unmount';
								await this.saveSettings();
								resolve('unmount');
							} else if (result === 'delete-always') {
								this.settings.mountRootDeletionBehavior = 'delete';
								await this.saveSettings();
								resolve('delete');
							} else {
								resolve(result as 'unmount' | 'delete' | 'cancel');
							}
						});
						modal.open();
					});
				}

				if (action === 'unmount') {
					const idx = this.settings.mountPoints.findIndex(m => m.id === mount.id);
					if (idx !== -1) {
						this.settings.mountPoints.splice(idx, 1);
						await this.saveSettings();
						this.pathMapper.update(this.settings.mountPoints, this.settings.deviceId);
						this.updateStatusBar();
					}
				}

				return action;
			},
			// onMountRootMove: called when the user drags/moves a mount root in the file explorer
			async (mount: MountPoint, newVirtualPath: string) => {
				await this.updateMount(mount.id, { ...mount, virtualPath: newVirtualPath });
			},
			(name: string, mount: MountPoint, mountRelativePath?: string) => {
				return this.isNameIgnored(name, mount, mountRelativePath);
			}
		);

		// Wrap with a Proxy so that any undocumented methods on the original
		// adapter (internal Obsidian APIs) still work transparently.
		vault.adapter = new Proxy(this.virtualAdapter, {
			get(target, prop, receiver) {
				// If VirtualAdapter has the property, use it
				if (prop in target) {
					const val = Reflect.get(target, prop, receiver);
					return typeof val === 'function' ? val.bind(target) : val;
				}
				// Otherwise fall through to the original adapter
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const orig = (target as any).orig?.();
				if (orig && prop in orig) {
					const val = orig[prop as keyof typeof orig];
					return typeof val === 'function' ? val.bind(orig) : val;
				}
				return undefined;
			},
		});

		// Obsidian's renderer calls Vault.getResourcePath(TFile) directly — it does NOT
		// go through the adapter. We must also patch the vault-level method so that
		// embedded images in mounted folders resolve to the real disk path.
		this.originalVaultGetResourcePath = vault.getResourcePath?.bind(vault);
		const pathMapper = this.pathMapper;
		vault.getResourcePath = (file: TFile): string => {
			const mount = pathMapper.getMountForPath(file.path);
			if (mount) {
				const realPath = pathMapper.toRealPath(file.path, mount);
				// Modern Obsidian uses app://<vaultId>/ which is restricted to
				// vault-relative paths — external mounts get ERR_FILE_NOT_FOUND.
				// Serve supported binary assets (images, PDFs) as data: URIs instead.
				// For large or unsupported files fall back to app://local/ (legacy).
				return tryReadAsDataUri(realPath, (this.settings.maxDataUriMB ?? 10) * 1024 * 1024) ?? realPathToResourceUrl(realPath);
			}
			// Fallback to original vault method for non-mounted files
			if (typeof this.originalVaultGetResourcePath === 'function') {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				return (this.originalVaultGetResourcePath as any)(file);
			}
			return '';
		};
	}

	// ------------------------------------------------------------------
	// Mount management
	// ------------------------------------------------------------------

	async addMount(mountData: Omit<MountPoint, 'id'>): Promise<void> {
		const isWebDAV = (mountData as MountPoint).mountType === 'webdav';

		// Validate against existing mounts before inserting (local mounts only —
		// WebDAV realPath is a server-relative path, not an absolute local path)
		if (!isWebDAV) {
			const error = this.security.validateMount(mountData, this.settings.mountPoints);
			if (error) {
				new Notice(`Folder Bridge: ${error}`);
				return;
			}
			// Surface advisory warnings (UNC paths, real-path overlaps)
			const warnings = this.security.getPathWarnings(mountData.realPath, this.settings.mountPoints);
			for (const w of warnings) {
				new Notice(`Folder Bridge warning: ${w}`, 10_000);
			}
		}

		// Extract + strip transient password before persisting
		const { webdavPassword, ...mountDataClean } = mountData as MountPoint;

		const mount: MountPoint = {
			...mountDataClean,
			id: generateId(),
			deviceId: this.settings.deviceId,
			// Vault mounts get a broader default ignore list to avoid exposing
			// the other vault's internal Obsidian config and trash to this vault.
			ignoreList: mountDataClean.mountType === 'vault'
				? ['.git', 'node_modules', '.obsidian', '.trash', '.smart-connections']
				: ['.git', 'node_modules', '.obsidian']
		};
		this.settings.mountPoints.push(mount);

		// Register in allowlist if not already present (local mounts only)
		if (mount.mountType !== 'webdav' && !this.settings.allowlist.includes(mount.realPath)) {
			this.settings.allowlist.push(mount.realPath);
			this.security.allow(mount.realPath);
		}

		// Wire up WebDAV adapter (password saved to sessionStorage, never data.json)
		if (mount.mountType === 'webdav') {
			if (webdavPassword) {
				WebDAVAdapter.savePassword(mount.id, webdavPassword);
				// Also persist an encrypted copy in the mount settings so it
				// survives Obsidian restarts (device-specific; safe to store).
				const encrypted = encryptPassword(webdavPassword);
				if (encrypted) {
					mount.encryptedWebdavPassword = encrypted;
					await this.saveSettings();
				}
			}
			const adapter = WebDAVAdapter.fromMount(mount);
			if (adapter) this.virtualAdapter?.setWebDAVAdapter(mount.id, adapter);
		}

		await this.saveSettings();
		this.pathMapper.update(this.settings.mountPoints, this.settings.deviceId);
		this.updateStatusBar();
		await this.notifyVaultMountAdded(mount);

		const mountLabel = mount.mountType === 'webdav'
			? `"${mount.webdavUrl}" → "${mount.virtualPath}"`
			: `"${mount.realPath}" → "${mount.virtualPath}"`;
		new Notice(`Folder Bridge: Mounted ${mountLabel}`);
	}

	async removeMount(id: string): Promise<void> {
		const idx = this.settings.mountPoints.findIndex(m => m.id === id);
		if (idx === -1) return;

		const mount = this.settings.mountPoints[idx];

		// [BUGFIX_20260222] Remove from vault tree BEFORE removing from pathMapper so stat() still resolves
		await this.notifyVaultMountRemoved(mount);

		this.settings.mountPoints.splice(idx, 1);

		// Only revoke the allowlist entry if no other active mount shares the real path
		const stillUsed = this.settings.mountPoints.some(m => m.realPath === mount.realPath);
		if (!stillUsed) {
			this.settings.allowlist = this.settings.allowlist.filter(p => p !== mount.realPath);
			this.security.revoke(mount.realPath);
		}

		// Tear down WebDAV adapter and clear stored password
		if (mount.mountType === 'webdav') {
			this.virtualAdapter?.clearWebDAVAdapter(mount.id);
			WebDAVAdapter.clearPassword(mount.id);
			// Remove the persisted encrypted credential from settings
			if (mount.encryptedWebdavPassword) {
				delete mount.encryptedWebdavPassword;
				await this.saveSettings();
			}
		}

		await this.saveSettings();
		this.pathMapper.update(this.settings.mountPoints, this.settings.deviceId);
		this.updateStatusBar();

		new Notice(`Folder Bridge: Removed mount "${mount.virtualPath}"`);
	}

	/**
	 * Update an existing mount in-place.  Handles vault-tree re-injection when
	 * the virtual path or real path changes, and keeps the allowlist in sync.
	 */
	async updateMount(id: string, newData: Omit<MountPoint, 'id'>): Promise<void> {
		const idx = this.settings.mountPoints.findIndex(m => m.id === id);
		if (idx === -1) return;

		const oldMount = this.settings.mountPoints[idx];

		// Validate against all OTHER mounts (exclude the one being edited)
		const otherMounts = this.settings.mountPoints.filter(m => m.id !== id);
		const error = this.security.validateMount(newData, otherMounts);
		if (error) {
			new Notice(`Folder Bridge: ${error}`);
			return;
		}

		const wasEnabled = oldMount.enabled;
		const virtualPathChanged = normalizePath(oldMount.virtualPath) !== normalizePath(newData.virtualPath);
		const realPathChanged = oldMount.realPath !== newData.realPath;

		// Remove from vault tree before mutating PathMapper state
		if (wasEnabled && (virtualPathChanged || realPathChanged)) {
			await this.notifyVaultMountRemoved(oldMount);
		}

		// Keep allowlist in sync when real path changes
		if (realPathChanged) {
			const stillUsed = otherMounts.some(m => m.realPath === oldMount.realPath);
			if (!stillUsed) {
				this.settings.allowlist = this.settings.allowlist.filter(p => p !== oldMount.realPath);
				this.security.revoke(oldMount.realPath);
			}
			if (!this.settings.allowlist.includes(newData.realPath)) {
				this.settings.allowlist.push(newData.realPath);
				this.security.allow(newData.realPath);
			}
		}

		// Preserve id, deviceId, ignoreList, and deviceOverrides from the original
		this.settings.mountPoints[idx] = {
			...oldMount,
			...newData,
			id,
		};

		await this.saveSettings();
		this.pathMapper.update(this.settings.mountPoints, this.settings.deviceId);
		this.updateStatusBar();

		const updatedMount = this.settings.mountPoints[idx];

		// Re-inject when enabled and something structural changed
		if (wasEnabled && (virtualPathChanged || realPathChanged)) {
			await this.notifyVaultMountAdded(updatedMount);
		}

		// Restart watcher on the new real path if needed
		if (realPathChanged && wasEnabled) {
			this.fileWatcher?.stopWatching(oldMount);
			this.fileWatcher?.startWatching(updatedMount);
		}

		// Recreate WebDAV adapter if any WebDAV fields changed
		if (updatedMount.mountType === 'webdav') {
			const { webdavPassword } = newData as MountPoint;
			if (webdavPassword) {
				WebDAVAdapter.savePassword(id, webdavPassword);
				// Persist updated encrypted copy
				const encrypted = encryptPassword(webdavPassword);
				if (encrypted) {
					this.settings.mountPoints[idx].encryptedWebdavPassword = encrypted;
					await this.saveSettings();
				}
			}
			this.virtualAdapter?.clearWebDAVAdapter(id);
			const adapter = WebDAVAdapter.fromMount(updatedMount);
			if (adapter) this.virtualAdapter?.setWebDAVAdapter(id, adapter);
		} else if (oldMount.mountType === 'webdav') {
			// Mount type changed away from WebDAV — clean up
			this.virtualAdapter?.clearWebDAVAdapter(id);
			WebDAVAdapter.clearPassword(id);
		}

		new Notice(`Folder Bridge: Updated "${updatedMount.virtualPath}"`);
	}

	// ------------------------------------------------------------------
	// Vault file-tree injection
	// ------------------------------------------------------------------

	/**
	 * Notify Obsidian's internal vault index that a new virtual mount folder
	 * exists so it appears in the file explorer without requiring a restart.
	 *
	 * Obsidian's internal `vault.onChange('created', path)` is the same hook
	 * the OS file-watcher uses to signal new paths.  Because our VirtualAdapter
	 * intercepts `adapter.stat()`, Obsidian correctly identifies each segment
	 * as a folder and inserts it into its internal TFolder tree.
	 */
	async notifyVaultMountAdded(mount: MountPoint): Promise<void> {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const vault = this.app.vault as any;

		if (typeof vault.onChange !== 'function') {
			console.log("vault.onChange is not a function!");
			return;
		}

		// Walk every path segment so intermediate virtual folders also appear
		// (e.g. mounting "Projects/Work" also surfaces the "Projects" folder).
		const segments = normalizePath(mount.virtualPath).split('/');
		for (let i = 1; i <= segments.length; i++) {
			const partPath = segments.slice(0, i).join('/');
			// Skip segments Obsidian already knows about
			if (this.app.vault.getAbstractFileByPath(partPath)) continue;
			try {
				await vault.onChange('folder-created', partPath, null, null);
			} catch (e) {
				console.debug('Folder Bridge: vault.onChange(folder-created) unavailable', e);
			}
		}

		// Recursively notify Obsidian about all files and folders inside the mount
		let fileCount = 0;
		let folderCount = 0;
		let isHuge = false;
		const scanLimit = mount.maxFiles ?? 0; // 0 = unlimited
		let scanLimitHit = false;

		const notice = new Notice(`Folder Bridge: Scanning and mounting "${mount.virtualPath}"...`, 0);

		const recursivelyNotifyVault = async (folderPath: string) => {
			if (scanLimitHit) return;
			try {
				const list = await this.app.vault.adapter.list(folderPath);

				// Yield to the event loop to prevent locking up the UI
				await new Promise(resolve => setTimeout(resolve, 0));

				for (const folder of list.folders) {
					if (scanLimitHit) return;

					const folderName = folder.split('/').pop() || '';
					const mountVirtual = normalizePath(mount.virtualPath);
					const folderMountRelPath = folder.startsWith(mountVirtual + '/')
						? folder.slice(mountVirtual.length + 1)
						: undefined;

					// Skip ignored folders
					if (this.isNameIgnored(folderName, mount, folderMountRelPath)) continue;

					// Skip hidden folders and node_modules to prevent massive performance hits
					if (folderName.startsWith('.') || folderName === 'node_modules') continue;

					if (!this.app.vault.getAbstractFileByPath(folder)) {
						await vault.onChange('folder-created', folder, null, null);
						folderCount++;
						if (scanLimit > 0 && fileCount + folderCount >= scanLimit) {
							scanLimitHit = true;
							return;
						}
					}

					if (folderCount + fileCount > 1000 && !isHuge) {
						isHuge = true;
						new Notice(`Folder Bridge: "${mount.virtualPath}" is very large. This may take a moment...`);
					}

					await recursivelyNotifyVault(folder);
				}
				for (let i = 0; i < list.files.length; i++) {
					if (scanLimitHit) break;

					const file = list.files[i];
					// Yield every 100 files to prevent locking up the UI on massive flat folders
					if (i > 0 && i % 100 === 0) {
						await new Promise(resolve => setTimeout(resolve, 0));
					}

					const fileName = file.split('/').pop() || '';
					const mountVirtualF = normalizePath(mount.virtualPath);
					const fileMountRelPath = file.startsWith(mountVirtualF + '/')
						? file.slice(mountVirtualF.length + 1)
						: undefined;

					// Skip ignored files
					if (this.isNameIgnored(fileName, mount, fileMountRelPath)) continue;

					// Skip hidden files
					if (fileName.startsWith('.')) continue;

					if (!this.app.vault.getAbstractFileByPath(file)) {
						const stat = await this.app.vault.adapter.stat(file);
						await vault.onChange('file-created', file, null, stat);
						fileCount++;
						if (scanLimit > 0 && fileCount + folderCount >= scanLimit) {
							scanLimitHit = true;
							break;
						}
					}
				}
			} catch (e) {
				console.debug(`Folder Bridge: Failed to list ${folderPath}`, e);
			}
		};

		await recursivelyNotifyVault(normalizePath(mount.virtualPath));
		notice.hide();
		if (scanLimitHit) {
			new Notice(
				`Folder Bridge: Scan limit (${scanLimit.toLocaleString()} items) reached for "${mount.virtualPath}". ` +
				`Increase "Max files" in mount Advanced settings to surface more.`,
				10000
			);
		}
		new Notice(`Folder Bridge: Mounted ${folderCount} folders and ${fileCount} files in "${mount.virtualPath}"`);
		try {
			await vault.onChange('raw', normalizePath(mount.virtualPath), null, null);
		} catch (e) {
			console.debug('Folder Bridge: vault.onChange(raw) unavailable', e);
		}

		// Force the file explorer to refresh the folder contents by expanding and collapsing it
		setTimeout(() => {
			const fileExplorerLeaves = this.app.workspace.getLeavesOfType('file-explorer');
			if (fileExplorerLeaves.length === 0) return;

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const fileExplorerView = fileExplorerLeaves[0].view as any;
			const fileItems = fileExplorerView.fileItems as Record<string, { setCollapsed?: (collapsed: boolean) => void }>;

			const folderPath = normalizePath(mount.virtualPath);
			if (fileItems && fileItems[folderPath]) {
				const folderItem = fileItems[folderPath];
				if (typeof folderItem.setCollapsed === 'function') {
					folderItem.setCollapsed(false);
				}
			}
		}, 100);

		// [FEATURE_20260222] Start watching the mount for external changes
		this.fileWatcher?.startWatching(mount);
	}

	/**
	 * Remove a virtual mount folder from Obsidian's internal vault index
	 * so the file explorer stops showing it immediately after removal.
	 * 
	 * [BUGFIX_20260222] This method must be called BEFORE the mount is removed
	 * from the PathMapper, otherwise adapter.list() will fail to resolve the
	 * virtual paths to real paths, and the files will remain orphaned in the UI.
	 */
	async notifyVaultMountRemoved(mount: MountPoint): Promise<void> {
		// [FEATURE_20260222] Stop watching the mount for external changes
		this.fileWatcher?.stopWatching(mount);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const vault = this.app.vault as any;
		if (typeof vault.onChange !== 'function') return;

		const nPath = normalizePath(mount.virtualPath);
		if (!this.app.vault.getAbstractFileByPath(nPath)) return;

		// Recursively remove all files and folders inside the mount
		const recursivelyRemoveVault = async (folderPath: string) => {
			try {
				const list = await this.app.vault.adapter.list(folderPath);
				for (const file of list.files) {
					if (this.app.vault.getAbstractFileByPath(file)) {
						console.debug(`[FolderBridge] Removing file from UI: ${file}`);
						await vault.onChange('file-removed', file, null, null);
					}
				}
				for (const folder of list.folders) {
					await recursivelyRemoveVault(folder);
					if (this.app.vault.getAbstractFileByPath(folder)) {
						console.debug(`[FolderBridge] Removing folder from UI: ${folder}`);
						await vault.onChange('folder-removed', folder, null, null);
					}
				}
			} catch (e) {
				console.debug(`Folder Bridge: Failed to list ${folderPath} during removal`, e);
			}
		};

		await recursivelyRemoveVault(nPath);

		try {
			console.debug(`[FolderBridge] Removing root mount folder from UI: ${nPath}`);
			await vault.onChange('folder-removed', nPath, null, null);
		} catch (e) {
			console.debug('Folder Bridge: vault.onChange(folder-removed) unavailable', e);
		}
	}

	// ------------------------------------------------------------------
	// Ignore-list helpers
	// ------------------------------------------------------------------

	/**
	 * Rebuild the ignore cache and immediately remove from Obsidian's vault
	 * index any files/folders under `mount` that are now matched by the
	 * current ignore list.  Call this after adding a new pattern so the file
	 * explorer hides matching items without requiring a restart.
	 */
	async applyIgnoreListToVault(mount: MountPoint): Promise<void> {
		this.updateIgnoreCache();

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const vault = this.app.vault as any;
		if (typeof vault.onChange !== 'function') return;

		const mountPath = normalizePath(mount.virtualPath);
		const mountFolder = this.app.vault.getAbstractFileByPath(mountPath);
		if (!(mountFolder instanceof TFolder)) return;

		const recursivelyRemoveIgnored = async (folder: TFolder): Promise<void> => {
			for (const child of [...folder.children]) {
				const mountRelative = child.path.startsWith(mountPath + '/')
					? child.path.slice(mountPath.length + 1)
					: child.path;
				if (this.isNameIgnored(child.name, mount, mountRelative)) {
					try {
						if (child instanceof TFolder) {
							await vault.onChange('folder-removed', child.path, null, null);
						} else {
							await vault.onChange('file-removed', child.path, null, null);
						}
					} catch (e) {
						console.debug('Folder Bridge: Failed to remove ignored item from vault view', e);
					}
				} else if (child instanceof TFolder) {
					await recursivelyRemoveIgnored(child);
				}
			}
		};

		await recursivelyRemoveIgnored(mountFolder);
	}

	// ------------------------------------------------------------------
	// Mount health checking
	// ------------------------------------------------------------------

	/**
	 * Start the background 30-second reachability loop.
	 * Runs one immediate check on call, then fires every CHECK_INTERVAL_MS.
	 * When reachability changes, fires a Notice and refreshes the status bar.
	 */
	private startHealthChecks(): void {
		const CHECK_INTERVAL_MS = 30_000;

		const runCheck = async () => {
			// Avoid churning I/O while Obsidian is in the background
			if (typeof document !== 'undefined' && document.hidden) return;

			const activeMounts = this.settings.mountPoints.filter(
				m => m.enabled && (m.deviceId === this.settings.deviceId || this.settings.allowForeignMounts)
			);

			let anyChanged = false;
			for (const mount of activeMounts) {
				let reachable = false;
				try {
					if (mount.mountType === 'webdav') {
						const adapter = WebDAVAdapter.fromMount(mount);
						if (adapter) {
							reachable = await adapter.exists(mount.realPath);
						}
					} else {
						// Local mounts require Node.js fs — unavailable on mobile
						if (fs && fs.promises) {
							const realPath = this.pathMapper.getEffectiveRealPath(mount);
							await fs.promises.access(realPath, fs.constants.F_OK);
							reachable = true;
						}
					}
				} catch {
					reachable = false;
				}
				const prev = this.mountHealthMap.get(mount.id);
				if (prev !== reachable) {
					this.mountHealthMap.set(mount.id, reachable);
					anyChanged = true;
					if (!reachable && prev === true) {
						new Notice(
							`⚠️ Folder Bridge: "${mount.label || mount.virtualPath}" is unreachable. ` +
							`Check that the path exists and is accessible on this device.`,
							8000
						);
					} else if (reachable && prev === false) {
						new Notice(
							`✓ Folder Bridge: "${mount.label || mount.virtualPath}" is back online.`,
							4000
						);
					}
				}
			}
			if (anyChanged) this.updateStatusBar();
		};

		void runCheck(); // immediate first pass
		this.healthCheckInterval = setInterval(() => void runCheck(), CHECK_INTERVAL_MS);
	}

	/**
	 * Re-check whether mount's real path is accessible now.
	 * If it is, remove stale vault-tree entries and re-inject the mount.
	 * Called from the settings tab "Reconnect" button.
	 */
	async reconnectMount(mount: MountPoint): Promise<void> {
		let reachable = false;
		try {
			if (mount.mountType === 'webdav') {
				const adapter = WebDAVAdapter.fromMount(mount);
				if (adapter) reachable = await adapter.exists(mount.realPath);
			} else {
				if (fs && fs.promises) {
					const realPath = this.pathMapper.getEffectiveRealPath(mount);
					await fs.promises.access(realPath, fs.constants.F_OK);
					reachable = true;
				}
			}
		} catch {
			reachable = false;
		}
		this.mountHealthMap.set(mount.id, reachable);

		if (!reachable) {
			new Notice(`Folder Bridge: "${mount.label || mount.virtualPath}" is still unreachable.`, 5000);
			this.updateStatusBar();
			return;
		}

		// Clean up any stale vault-tree remnants before re-injecting
		await this.notifyVaultMountRemoved(mount);
		await this.notifyVaultMountAdded(mount);
		new Notice(`✓ Folder Bridge: "${mount.label || mount.virtualPath}" reconnected successfully.`);
		this.updateStatusBar();
	}

	// ------------------------------------------------------------------
	// Status bar
	// ------------------------------------------------------------------

	updateStatusBar(): void {
		if (!this.statusBarItem) return;
		const active = this.settings.mountPoints.filter(m => m.enabled).length;
		const unreachableCount = [...this.mountHealthMap.values()].filter(v => v === false).length;
		if (unreachableCount > 0) {
			this.statusBarItem.setText(`⚠️ Folder Bridge: ${unreachableCount} unreachable`);
			this.statusBarItem.style.color = 'var(--text-warning)';
		} else {
			this.statusBarItem.setText(`Folder Bridge: ${active} mount${active !== 1 ? 's' : ''}`);
			this.statusBarItem.style.color = '';
		}
	}

	// ------------------------------------------------------------------
	// Settings persistence
	// ------------------------------------------------------------------

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		// Generate a unique device ID if one doesn't exist
		if (!this.settings.deviceId) {
			this.settings.deviceId = generateId();
			await this.saveSettings();
		}

		// Back-compat: assign ids to mounts created before the id field existed
		for (const m of this.settings.mountPoints) {
			if (!m.id) m.id = generateId();
			// Back-compat: assign deviceId to mounts created before deviceId existed
			if (!m.deviceId) m.deviceId = this.settings.deviceId;
		}

		// Back-compat: migrate global ignoreList to per-mount ignoreList
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const anySettings = this.settings as any;
		if (anySettings.ignoreList && Array.isArray(anySettings.ignoreList)) {
			for (const m of this.settings.mountPoints) {
				if (!m.ignoreList) {
					m.ignoreList = [...anySettings.ignoreList];
				}
			}
			delete anySettings.ignoreList;
			await this.saveSettings();
		}

		this.updateIgnoreCache();
	}

	async saveSettings() {
		// Strip transient webdavPassword field before persisting — it must never
		// reach data.json.  We deep-clone only the mount points array to avoid
		// mutating the live in-memory objects.
		const dataToSave = {
			...this.settings,
			mountPoints: this.settings.mountPoints.map(m => {
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
				const { webdavPassword: _pw, ...rest } = m;
				return rest;
			}),
		};
		await this.saveData(dataToSave);
		this.updateIgnoreCache();
	}
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class FolderBridgeSettingTab extends PluginSettingTab {
	plugin: FolderBridgePlugin;
	private selectedIgnoreMountId: string | null = null;
	/** ID of the mount row being dragged (for reorder drag-drop). */
	private dragSrcId: string | null = null;

	constructor(app: App, plugin: FolderBridgePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		// Render sync part, then trigger async refresh for mount statuses
		this.renderSync();
	}

	private renderSync(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ── Header ──────────────────────────────────────────────────────
		new Setting(containerEl)
			.setName('Folder Bridge')
			.setDesc('Mount external folders as native-feeling directories inside your vault.')
			.setHeading();

		const infoDiv = containerEl.createDiv('folderbridge-info-box');
		infoDiv.style.padding = '10px';
		infoDiv.style.backgroundColor = 'var(--background-modifier-message)';
		infoDiv.style.border = '1px solid var(--background-modifier-border)';
		infoDiv.style.borderRadius = '4px';
		infoDiv.style.marginBottom = '20px';

		infoDiv.createEl('p', {
			text: `Platform: ${getPlatform()} | Device ID: ${this.plugin.settings.deviceId.substring(0, 8)}`,
			cls: 'setting-item-description',
		}).style.margin = '0 0 10px 0';

		const syncWarning = infoDiv.createEl('p', {
			cls: 'setting-item-description',
		});
		syncWarning.style.margin = '0';
		syncWarning.style.color = 'var(--text-warning)';
		syncWarning.createEl('strong', { text: '⚠️ Sync Warning:' });
		syncWarning.appendText(' If you use Obsidian Sync or Syncthing, you ');
		syncWarning.createEl('strong', { text: 'must' });
		syncWarning.appendText(' add your virtual folder names to your sync ignore list (e.g. ');
		syncWarning.createEl('code', { text: '.stignore' });
		syncWarning.appendText(' or Obsidian Sync Excluded Folders). Otherwise, your sync engine will try to upload the entire contents of your mounted folders!');

		// ── Global options ───────────────────────────────────────────────
		new Setting(containerEl).setName('General').setHeading();

		new Setting(containerEl)
			.setName('Dry-run mode')
			.setDesc('Log write operations to the console without executing them. Useful for debugging.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.dryRun)
				.onChange(async val => {
					this.plugin.settings.dryRun = val;
					await this.plugin.saveSettings();
					this.plugin.virtualAdapter?.setDryRun(val);
				}));

		new Setting(containerEl)
			.setName('Show status bar item')
			.setDesc('Display the active mount count in Obsidian\'s status bar.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showStatusBar)
				.onChange(async val => {
					this.plugin.settings.showStatusBar = val;
					await this.plugin.saveSettings();

					// Dynamically show/hide the status bar item without requiring a reload
					if (val) {
						// Show status bar item if it doesn't exist yet
						if (!this.plugin.statusBarItem) {
							this.plugin.statusBarItem = this.plugin.addStatusBarItem();
							this.plugin.updateStatusBar();
						}
					} else {
						// Hide status bar item if it exists
						if (this.plugin.statusBarItem) {
							this.plugin.statusBarItem.remove();
							// @ts-ignore - statusBarItem may be typed as non-null elsewhere
							this.plugin.statusBarItem = null;
						}
					}
				}));

		new Setting(containerEl)
			.setName('Mount root deletion behavior')
			.setDesc('What should happen when you delete a mounted folder from the file explorer?')
			.addDropdown(drop => drop
				.addOption('ask', 'Ask me every time')
				.addOption('unmount', 'Unmount only (keep real files)')
				.addOption('delete', 'Delete permanently (destroy real files)')
				.setValue(this.plugin.settings.mountRootDeletionBehavior)
				.onChange(async (val: 'ask' | 'unmount' | 'delete') => {
					this.plugin.settings.mountRootDeletionBehavior = val;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Allow foreign mounts')
			.setDesc('Allow mounting paths created on other devices. Enable this if you use Syncthing to sync the actual mounted folders across devices and the paths are identical.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.allowForeignMounts)
				.onChange(async val => {
					this.plugin.settings.allowForeignMounts = val;
					await this.plugin.saveSettings();
					this.display(); // Refresh to update toggle states
				}));

		new Setting(containerEl)
			.setName('Image / PDF size cap (MB)')
			.setDesc('Maximum file size that will be embedded as a data: URI (used for images and PDFs in external mounts). Files larger than this fall back to a resource URL. Default: 10 MB.')
			.addText(text => text
				.setPlaceholder('10')
				.setValue(String(this.plugin.settings.maxDataUriMB ?? 10))
				.onChange(async val => {
					const parsed = parseFloat(val);
					if (!isNaN(parsed) && parsed > 0) {
						this.plugin.settings.maxDataUriMB = parsed;
						await this.plugin.saveSettings();
						this.plugin.virtualAdapter?.setMaxDataUri(parsed * 1024 * 1024);
					}
				}));

		// ── Ignore Lists ─────────────────────────────────────────────────
		new Setting(containerEl).setName('Ignore Lists').setHeading();

		// ── Global ignore patterns ───────────────────────────────────────
		new Setting(containerEl)
			.setName('Global ignore patterns')
			.setDesc('Patterns applied to every mount. Same syntax as per-mount patterns: plain names match any leaf, globs (*.tmp) match leaf names, paths with / match subtrees. Pre-populated with common OS noise files.')
			.setHeading();

		const globalIgnoreContainer = containerEl.createDiv('folderbridge-global-ignore');
		globalIgnoreContainer.style.marginBottom = '20px';
		globalIgnoreContainer.style.padding = '10px';
		globalIgnoreContainer.style.border = '1px solid var(--background-modifier-border)';
		globalIgnoreContainer.style.borderRadius = '4px';

		const renderGlobalIgnoreList = () => {
			globalIgnoreContainer.empty();
			const list = this.plugin.settings.globalIgnorePatterns || [];
			if (list.length === 0) {
				globalIgnoreContainer.createEl('p', { text: 'No global patterns. Files like .DS_Store are visible in all mounts.', cls: 'setting-item-description' });
			}
			for (const item of list) {
				const itemEl = globalIgnoreContainer.createDiv('folderbridge-ignore-item');
				itemEl.style.display = 'flex';
				itemEl.style.alignItems = 'center';
				itemEl.style.justifyContent = 'space-between';
				itemEl.style.marginBottom = '6px';
				itemEl.createSpan({ text: item }).style.flexGrow = '1';
				const removeBtn = itemEl.createEl('button', { text: 'Remove' });
				removeBtn.onclick = async () => {
					this.plugin.settings.globalIgnorePatterns = this.plugin.settings.globalIgnorePatterns.filter(i => i !== item);
					await this.plugin.saveSettings();
					this.plugin.updateIgnoreCachePublic();
					renderGlobalIgnoreList();
				};
			}
			const addContainer = globalIgnoreContainer.createDiv();
			addContainer.style.display = 'flex';
			addContainer.style.marginTop = '12px';
			addContainer.style.gap = '8px';
			const inputEl = addContainer.createEl('input', { type: 'text', placeholder: 'e.g. .DS_Store, Thumbs.db, *.tmp, node_modules' });
			inputEl.style.flexGrow = '1';
			const addBtn = addContainer.createEl('button', { text: 'Add' });
			addBtn.onclick = async () => {
				const val = inputEl.value.trim();
				if (val) {
					if (!this.plugin.settings.globalIgnorePatterns) this.plugin.settings.globalIgnorePatterns = [];
					if (!this.plugin.settings.globalIgnorePatterns.includes(val)) {
						this.plugin.settings.globalIgnorePatterns.push(val);
						await this.plugin.saveSettings();
						this.plugin.updateIgnoreCachePublic();
						inputEl.value = '';
						renderGlobalIgnoreList();
					}
				}
			};
			inputEl.addEventListener('keypress', e => { if (e.key === 'Enter') addBtn.click(); });
		};
		renderGlobalIgnoreList();

		// ── Per-mount ignore lists ────────────────────────────────────────
		new Setting(containerEl)
			.setName('Per-mount ignore lists')
			.setDesc('Patterns applied to a specific mount only.')
			.setHeading();

		if (this.plugin.settings.mountPoints.length === 0) {
			containerEl.createEl('p', {
				text: 'Add a mount point first to configure its ignore list.',
				cls: 'setting-item-description',
			});
		} else {
			// Ensure a valid selection
			if (!this.selectedIgnoreMountId || !this.plugin.settings.mountPoints.find(m => m.id === this.selectedIgnoreMountId)) {
				this.selectedIgnoreMountId = this.plugin.settings.mountPoints[0].id;
			}

			new Setting(containerEl)
				.setName('Select mount')
				.setDesc('Choose which mount\'s ignore list to edit.')
				.addDropdown(drop => {
					for (const m of this.plugin.settings.mountPoints) {
						drop.addOption(m.id, m.label || m.virtualPath);
					}
					drop.setValue(this.selectedIgnoreMountId!);
					drop.onChange(val => {
						this.selectedIgnoreMountId = val;
						this.display(); // Re-render to show the selected mount's list
					});
				});

			const selectedMount = this.plugin.settings.mountPoints.find(m => m.id === this.selectedIgnoreMountId);
			if (selectedMount) {
				const ignoreListContainer = containerEl.createDiv('folderbridge-ignore-list');
				ignoreListContainer.style.marginTop = '10px';
				ignoreListContainer.style.marginBottom = '20px';
				ignoreListContainer.style.padding = '10px';
				ignoreListContainer.style.border = '1px solid var(--background-modifier-border)';
				ignoreListContainer.style.borderRadius = '4px';

				const renderIgnoreList = () => {
					ignoreListContainer.empty();

					const list = selectedMount.ignoreList || [];
					if (list.length === 0) {
						ignoreListContainer.createEl('p', { text: 'No items ignored for this mount.', cls: 'setting-item-description' });
					}

					for (const item of list) {
						const itemEl = ignoreListContainer.createDiv('folderbridge-ignore-item');
						itemEl.style.display = 'flex';
						itemEl.style.alignItems = 'center';
						itemEl.style.justifyContent = 'space-between';
						itemEl.style.marginBottom = '6px';

						itemEl.createSpan({ text: item }).style.flexGrow = '1';

						const removeBtn = itemEl.createEl('button', { text: 'Remove' });
						removeBtn.onclick = async () => {
							selectedMount.ignoreList = selectedMount.ignoreList!.filter(i => i !== item);
							await this.plugin.saveSettings();
							renderIgnoreList();
						};
					}

					const addContainer = ignoreListContainer.createDiv('folderbridge-ignore-add');
					addContainer.style.display = 'flex';
					addContainer.style.marginTop = '12px';
					addContainer.style.gap = '8px';

					const inputEl = addContainer.createEl('input', { type: 'text', placeholder: 'Name (e.g. .DS_Store) or path (e.g. vendor/cache)' });
					inputEl.style.flexGrow = '1';

					// Browse mount button — opens disk picker rooted at the mount's real path
					const browseBtn = addContainer.createEl('button', { text: 'Browse…' });
					browseBtn.onclick = async () => {
						const selected = await browseFolderOnDisk(
							`Select folder to ignore in "${selectedMount.label || selectedMount.virtualPath}"`,
							selectedMount.realPath,
						);
						if (selected) {
							// Normalize to forward slashes and strip mount real-path prefix
							const mountReal = selectedMount.realPath.replace(/\\/g, '/').replace(/\/$/, '');
							const sel = selected.replace(/\\/g, '/').replace(/\/$/, '');
							const relative = sel.startsWith(mountReal + '/')
								? sel.slice(mountReal.length + 1)
								: sel;
							// Pre-fill the text input so the user can review/edit before adding
							inputEl.value = relative;
							inputEl.focus();
						}
					};

					const addBtn = addContainer.createEl('button', { text: 'Add' });
					addBtn.onclick = async () => {
						const val = inputEl.value.trim();
						if (val) {
							if (!selectedMount.ignoreList) selectedMount.ignoreList = [];
							if (!selectedMount.ignoreList.includes(val)) {
								selectedMount.ignoreList.push(val);
								await this.plugin.saveSettings();
								// Rebuild cache and remove newly-ignored items from the file explorer
								await this.plugin.applyIgnoreListToVault(selectedMount);
								inputEl.value = '';
								renderIgnoreList();
							}
						}
					};

					inputEl.addEventListener('keypress', (e) => {
						if (e.key === 'Enter') {
							addBtn.click();
						}
					});
				};

				renderIgnoreList();
			}
		}

		// ── Mount points ─────────────────────────────────────────────────
		new Setting(containerEl).setName('Mount Points').setHeading();

		new Setting(containerEl)
			.setName('Add a new mount')
			.setDesc('Map an external folder to a virtual path inside your vault.')
			.addButton(btn => btn
				.setButtonText('Add Mount Point')
				.setCta()
				.onClick(() => {
					new MountManagerModal(
						this.app,
						this.plugin.security,
						async (mount) => {
							await this.plugin.addMount(mount);
							this.display();
						},
					).open();
				}))
			.addButton(btn => btn
				.setButtonText('Export…')
				.setTooltip('Export all mounts to a JSON file for backup or transfer')
				.onClick(() => {
					// Strip secrets before exporting
					const exportData = {
						version: '1',
						exportedAt: new Date().toISOString(),
						mountPoints: this.plugin.settings.mountPoints.map(m => {
							// eslint-disable-next-line @typescript-eslint/no-unused-vars
							const { encryptedWebdavPassword, webdavPassword, ...rest } = m;
							return rest;
						}),
					};
					const blob = new Blob([JSON.stringify(exportData, null, '\t')], { type: 'application/json' });
					const url = URL.createObjectURL(blob);
					const a = document.createElement('a');
					a.href = url;
					a.download = 'folderbridge-mounts.json';
					a.click();
					URL.revokeObjectURL(url);
				}))
			.addButton(btn => btn
				.setButtonText('Import…')
				.setTooltip('Import mounts from a previously exported JSON file')
				.onClick(() => {
					const input = document.createElement('input');
					input.type = 'file';
					input.accept = '.json,application/json';
					input.onchange = async () => {
						const file = input.files?.[0];
						if (!file) return;
						try {
							const text = await file.text();
							const parsed = JSON.parse(text);
							const mounts: MountPoint[] = Array.isArray(parsed)
								? parsed                        // legacy bare array
								: parsed.mountPoints ?? [];    // { version, mountPoints }
							if (!Array.isArray(mounts) || mounts.length === 0) {
								new Notice('Folder Bridge: No mount points found in the selected file.');
								return;
							}
							let added = 0, skipped = 0;
							for (const m of mounts) {
								if (typeof m.virtualPath !== 'string' || typeof m.realPath !== 'string') {
									skipped++; continue;
								}
								// Assign fresh ID and current device unless file already has a matching one
								const fresh: MountPoint = {
									...m,
									id: generateId(),
									deviceId: this.plugin.settings.deviceId,
									encryptedWebdavPassword: undefined,
									webdavPassword: undefined,
								};
								await this.plugin.addMount(fresh);
								added++;
							}
							new Notice(`Folder Bridge: Imported ${added} mount(s).${skipped ? ` ${skipped} skipped (invalid).` : ''}`);
							this.display();
						} catch (e) {
							new Notice('Folder Bridge: Failed to parse the selected file. Is it a valid Folder Bridge export?');
						}
					};
					input.click();
				}));

		// Render each existing mount (status loaded async below)
		if (this.plugin.settings.mountPoints.length === 0) {
			containerEl.createEl('p', {
				text: 'No mounts configured yet. Click "Add Mount Point" to get started.',
				cls: 'setting-item-description',
			});
		}

		// Wrap mount rows in a container so drag-drop only affects this list
		const mountListEl = containerEl.createDiv('folderbridge-mount-list');
		for (const mount of this.plugin.settings.mountPoints) {
			this.renderMountRow(mountListEl, mount);
		}
	}

	/** Render a single mount row synchronously, then patch status asynchronously. */
	private renderMountRow(containerEl: HTMLElement, mount: MountPoint): void {
		const isThisDevice = mount.deviceId === this.plugin.settings.deviceId;
		const canEnable = isThisDevice || this.plugin.settings.allowForeignMounts;
		const displayName = mount.label || mount.virtualPath;

		let desc = `${normalizePath(mount.virtualPath)} → ${mount.realPath}`;
		if (!isThisDevice) {
			desc += ` (Created on device: ${mount.deviceId?.substring(0, 8) || 'unknown'})`;
		}

		const effectivePath = this.plugin.pathMapper.getEffectiveRealPath(mount);
		if (effectivePath !== mount.realPath) {
			desc += `\n(Overridden on this device: ${effectivePath})`;
		}

		const setting = new Setting(containerEl)
			.setName(`${displayName}`)
			.setDesc(desc)
			.addToggle(toggle => {
				toggle
					.setValue(mount.enabled)
					.setTooltip(canEnable ? 'Enable / disable this mount' : 'This mount belongs to another device and cannot be enabled here.')
					.onChange(async val => {
						if (!canEnable) {
							// Revert the toggle visually if they try to enable a foreign mount
							toggle.setValue(false);
							new Notice('Folder Bridge: Cannot enable a mount created on a different device.');
							return;
						}

						// [BUGFIX_20260222] Fix UI refresh bug when unmounting
						// We must call notifyVaultMountRemoved BEFORE updating pathMapper
						// so that adapter.list() can still resolve the virtual paths to real paths
						// and find the files to remove from Obsidian's internal fileMap.
						if (!val) {
							await this.plugin.notifyVaultMountRemoved(mount);
						}

						mount.enabled = val;
						await this.plugin.saveSettings();
						this.plugin.pathMapper.update(this.plugin.settings.mountPoints, this.plugin.settings.deviceId);
						this.plugin.updateStatusBar();

						// Inject into Obsidian's vault tree live
						if (val) {
							await this.plugin.notifyVaultMountAdded(mount);
						}
					});

				// Disable the toggle entirely if it's not this device and foreign mounts aren't allowed
				if (!canEnable) {
					toggle.toggleEl.classList.add('is-disabled');
					toggle.toggleEl.style.opacity = '0.5';
					toggle.toggleEl.style.cursor = 'not-allowed';
				}
			});

		if (!isThisDevice) {
			setting.addButton(btn => btn
				.setButtonText('Override Path')
				.setTooltip('Set a different real path for this device')
				.onClick(async () => {
					const newPath = await browseFolderOnDisk('Select Real Folder for this Device');
					if (newPath) {
						if (!mount.deviceOverrides) mount.deviceOverrides = {};
						mount.deviceOverrides[this.plugin.settings.deviceId] = newPath;

						// Add to allowlist
						if (!this.plugin.settings.allowlist.includes(newPath)) {
							this.plugin.settings.allowlist.push(newPath);
							this.plugin.security.allow(newPath);
						}

						await this.plugin.saveSettings();
						this.plugin.pathMapper.update(this.plugin.settings.mountPoints, this.plugin.settings.deviceId);
						// Restart the file watcher so it tracks the new real path
						if (mount.enabled) {
							this.plugin.fileWatcher?.stopWatching(mount);
							this.plugin.fileWatcher?.startWatching(mount);
						}
						this.display();
						new Notice(`Folder Bridge: Path overridden for this device.`);
					}
				}));
		}

		// Edit button — opens the modal pre-populated with this mount's values
		if (isThisDevice) {
			setting.addButton(btn => btn
				.setButtonText('Edit')
				.setTooltip("Edit this mount's paths, label, or read-only flag")
				.onClick(() => {
					new MountManagerModal(
						this.app,
						this.plugin.security,
						async (updatedData, editId) => {
							if (editId) {
								await this.plugin.updateMount(editId, updatedData);
							}
							this.display();
						},
						mount, // pre-populate all fields
					).open();
				}));
		}

		if (!isThisDevice) {
			setting.addButton(btn => btn
				.setButtonText('Override Path')
				.setTooltip('Set a different real path for this device')
				.onClick(async () => {
					const newPath = await browseFolderOnDisk('Select Real Folder for this Device');
					if (newPath) {
						if (!mount.deviceOverrides) mount.deviceOverrides = {};
						mount.deviceOverrides[this.plugin.settings.deviceId] = newPath;

						// Add to allowlist
						if (!this.plugin.settings.allowlist.includes(newPath)) {
							this.plugin.settings.allowlist.push(newPath);
							this.plugin.security.allow(newPath);
						}

						await this.plugin.saveSettings();
						this.plugin.pathMapper.update(this.plugin.settings.mountPoints, this.plugin.settings.deviceId);
						// Restart the file watcher so it tracks the new real path
						if (mount.enabled) {
							this.plugin.fileWatcher?.stopWatching(mount);
							this.plugin.fileWatcher?.startWatching(mount);
						}
						this.display();
						new Notice(`Folder Bridge: Path overridden for this device.`);
					}
				}));
		}

		setting.addButton(btn => btn
			.setButtonText('Remove')
			.setWarning()
			.onClick(async () => {
				await this.plugin.removeMount(mount.id);
				this.display();
			}));

		// ── Drag-drop reordering ────────────────────────────────────────────
		const el = setting.settingEl;
		el.setAttribute('draggable', 'true');
		el.dataset.mountId = mount.id;
		el.addClass('folderbridge-draggable-row');

		el.addEventListener('dragstart', (e) => {
			this.dragSrcId = mount.id;
			el.addClass('folderbridge-drag-source');
			e.dataTransfer?.setData('text/plain', mount.id);
		});

		el.addEventListener('dragend', () => {
			this.dragSrcId = null;
			el.removeClass('folderbridge-drag-source');
			containerEl.querySelectorAll('.folderbridge-drag-over')
				.forEach(n => (n as HTMLElement).removeClass('folderbridge-drag-over'));
		});

		el.addEventListener('dragover', (e) => {
			if (this.dragSrcId && this.dragSrcId !== mount.id) {
				e.preventDefault();
				containerEl.querySelectorAll('.folderbridge-drag-over')
					.forEach(n => (n as HTMLElement).removeClass('folderbridge-drag-over'));
				el.addClass('folderbridge-drag-over');
			}
		});

		el.addEventListener('dragleave', (e) => {
			if (!el.contains(e.relatedTarget as Node)) {
				el.removeClass('folderbridge-drag-over');
			}
		});

		el.addEventListener('drop', async (e) => {
			e.preventDefault();
			el.removeClass('folderbridge-drag-over');
			if (!this.dragSrcId || this.dragSrcId === mount.id) return;

			const mounts = this.plugin.settings.mountPoints;
			const srcIdx = mounts.findIndex(m => m.id === this.dragSrcId);
			const dstIdx = mounts.findIndex(m => m.id === mount.id);
			if (srcIdx === -1 || dstIdx === -1) return;

			const [moved] = mounts.splice(srcIdx, 1);
			mounts.splice(dstIdx, 0, moved);

			await this.plugin.saveSettings();
			this.display();
		});

		// ── Reconnect button (shown immediately when mount is known unreachable) ────
		if (canEnable && this.plugin.mountHealthMap.get(mount.id) === false) {
			setting.addButton(btn => btn
				.setButtonText('⚠️ Reconnect')
				.setWarning()
				.onClick(async () => {
					await this.plugin.reconnectMount(mount);
					this.display();
				}));
		}

		// ── Async status badge ───────────────────────────────────────────────
		if (canEnable) {
			getMountStatus(mount).then(status => {
				const isUnreachable = this.plugin.mountHealthMap.get(mount.id) === false;
				const badge = isUnreachable
					? '[unreachable]'
					: status.reachable
						? (status.readOnly ? '[read-only]' : '[writable]')
						: `[error: ${status.error ?? 'unreachable'}]`;
				const prefix = (isUnreachable || !status.reachable) ? '✗' : '✓';
				setting.setName(`${prefix} ${displayName} ${badge}`);
				if (isUnreachable || !status.reachable) {
					setting.settingEl.style.borderLeft = '3px solid var(--text-warning)';
				}
			}).catch(() => { /* ignore render errors */ });
		} else {
			setting.setName(`[Other Device] ${displayName}`);
			setting.settingEl.style.opacity = '0.7';
		}
	}
}
