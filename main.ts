import { App, Plugin, PluginSettingTab, Setting, Notice, normalizePath, TFolder, TFile } from 'obsidian';
import { FolderBridgeSettings, MountPoint, DEFAULT_SETTINGS } from './src/types';
import { PathMapper } from './src/PathMapper';
import { VirtualAdapter } from './src/VirtualAdapter';
import { SecurityManager } from './src/SecurityManager';
import { MountManagerModal, getMountStatus, browseFolderOnDisk } from './src/ui/MountManagerModal';
import { MountRootDeleteModal } from './src/ui/MountRootDeleteModal';
import { getPlatform } from './src/OSHelpers';

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

	// Preserve original adapter so we can restore it on unload
	private originalAdapter: unknown = null;
	statusBarItem: HTMLElement | null = null;

	async onload() {
		await this.loadSettings();

		this.pathMapper = new PathMapper();
		this.security = new SecurityManager(this.settings.allowlist);
		this.pathMapper.update(this.settings.mountPoints, this.settings.deviceId);

		// Install the virtual adapter shim
		this.installVirtualAdapter();

		// Ribbon icon opens the add-mount modal
		const ribbonIconEl = this.addRibbonIcon('folder-plus', 'FolderBridge: Add Mount', () => {
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
				new Notice('FolderBridge: Mounts refreshed');
			}
		});

		// Add context menu item to ignore files/folders
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				// Only show if the file is inside a mounted folder
				const mount = this.pathMapper.getMountForPath(file.path);
				if (!mount) return;

				menu.addItem((item) => {
					item
						.setTitle(`Ignore "${file.name}" in FolderBridge`)
						.setIcon('eye-off')
						.onClick(async () => {
							if (!this.isNameIgnored(file.name, mount)) {
								if (!mount.ignoreList) mount.ignoreList = [];
								mount.ignoreList.push(file.name);
								await this.saveSettings();
								new Notice(`FolderBridge: Added "${file.name}" to ignore list for mount "${mount.virtualPath}".`);

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
										console.debug('FolderBridge: Failed to remove ignored item from view', e);
									}
								}
							} else {
								new Notice(`FolderBridge: "${file.name}" is already in the ignore list for this mount.`);
							}
						});
				});
			})
		);

		// After the workspace finishes loading, inject all enabled mounts into
		// Obsidian's internal vault file tree so they appear in the file explorer
		// without requiring a restart.
		this.app.workspace.onLayoutReady(async () => {
			for (const mount of this.settings.mountPoints.filter(m => m.enabled && (m.deviceId === this.settings.deviceId || this.settings.allowForeignMounts))) {
				await this.notifyVaultMountAdded(mount);
			}
		});

		console.log(`FolderBridge loaded (${getPlatform()}, ${this.settings.mountPoints.filter(m => m.enabled && (m.deviceId === this.settings.deviceId || this.settings.allowForeignMounts)).length} active mounts on this device)`);
	}

	onunload() {
		// Restore the original adapter so the vault works normally after unload
		if (this.originalAdapter) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(this.app.vault as any).adapter = this.originalAdapter;
			this.originalAdapter = null;
		}
		console.log('FolderBridge unloaded');
	}

	// ------------------------------------------------------------------
	// Helpers
	// ------------------------------------------------------------------

	private ignoreCache = new Map<string, { strings: string[], regexes: RegExp[] }>();

	private updateIgnoreCache() {
		this.ignoreCache.clear();
		for (const mount of this.settings.mountPoints) {
			const strings: string[] = [];
			const regexes: RegExp[] = [];
			const list = mount.ignoreList || [];
			for (const pattern of list) {
				if (pattern.includes('*')) {
					const regexStr = '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
					regexes.push(new RegExp(regexStr));
				} else {
					strings.push(pattern);
				}
			}
			this.ignoreCache.set(mount.id, { strings, regexes });
		}
	}

	isNameIgnored(name: string, mount: MountPoint): boolean {
		const cache = this.ignoreCache.get(mount.id);
		if (!cache) return false;
		if (cache.strings.includes(name)) return true;
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
			(name: string, mount: MountPoint) => {
				return this.isNameIgnored(name, mount);
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
	}

	// ------------------------------------------------------------------
	// Mount management
	// ------------------------------------------------------------------

	async addMount(mountData: Omit<MountPoint, 'id'>): Promise<void> {
		// Validate against existing mounts before inserting
		const error = this.security.validateMount(mountData, this.settings.mountPoints);
		if (error) {
			new Notice(`FolderBridge: ${error}`);
			return;
		}

		// Surface non-blocking advisory warnings (e.g. UNC paths, real-path overlaps)
		const warnings = this.security.getPathWarnings(mountData.realPath, this.settings.mountPoints);
		for (const w of warnings) {
			new Notice(`FolderBridge warning: ${w}`, 10_000);
		}

		const mount: MountPoint = {
			...mountData,
			id: generateId(),
			deviceId: this.settings.deviceId,
			ignoreList: ['.git', 'node_modules', '.obsidian']
		};
		this.settings.mountPoints.push(mount);

		// Register in allowlist if not already present
		if (!this.settings.allowlist.includes(mount.realPath)) {
			this.settings.allowlist.push(mount.realPath);
			this.security.allow(mount.realPath);
		}

		await this.saveSettings();
		this.pathMapper.update(this.settings.mountPoints, this.settings.deviceId);
		this.updateStatusBar();
		await this.notifyVaultMountAdded(mount);

		new Notice(`FolderBridge: Mounted "${mount.realPath}" → "${mount.virtualPath}"`);
	}

	async removeMount(id: string): Promise<void> {
		const idx = this.settings.mountPoints.findIndex(m => m.id === id);
		if (idx === -1) return;

		const mount = this.settings.mountPoints[idx];

		// Remove from vault tree BEFORE removing from pathMapper so stat() still resolves
		await this.notifyVaultMountRemoved(mount);

		this.settings.mountPoints.splice(idx, 1);

		// Only revoke the allowlist entry if no other active mount shares the real path
		const stillUsed = this.settings.mountPoints.some(m => m.realPath === mount.realPath);
		if (!stillUsed) {
			this.settings.allowlist = this.settings.allowlist.filter(p => p !== mount.realPath);
			this.security.revoke(mount.realPath);
		}

		await this.saveSettings();
		this.pathMapper.update(this.settings.mountPoints, this.settings.deviceId);
		this.updateStatusBar();

		new Notice(`FolderBridge: Removed mount "${mount.virtualPath}"`);
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
				console.debug('FolderBridge: vault.onChange(folder-created) unavailable', e);
			}
		}

		// Recursively notify Obsidian about all files and folders inside the mount
		let fileCount = 0;
		let folderCount = 0;
		let isHuge = false;

		const notice = new Notice(`FolderBridge: Scanning and mounting "${mount.virtualPath}"...`, 0);

		const recursivelyNotifyVault = async (folderPath: string) => {
			try {
				const list = await this.app.vault.adapter.list(folderPath);

				// Yield to the event loop to prevent locking up the UI
				await new Promise(resolve => setTimeout(resolve, 0));

				for (const folder of list.folders) {
					const folderName = folder.split('/').pop() || '';

					// Skip ignored folders
					if (this.isNameIgnored(folderName, mount)) continue;

					// Skip hidden folders and node_modules to prevent massive performance hits
					if (folderName.startsWith('.') || folderName === 'node_modules') continue;

					if (!this.app.vault.getAbstractFileByPath(folder)) {
						await vault.onChange('folder-created', folder, null, null);
						folderCount++;
					}

					if (folderCount + fileCount > 1000 && !isHuge) {
						isHuge = true;
						new Notice(`FolderBridge: "${mount.virtualPath}" is very large. This may take a moment...`);
					}

					await recursivelyNotifyVault(folder);
				}
				for (let i = 0; i < list.files.length; i++) {
					const file = list.files[i];
					// Yield every 100 files to prevent locking up the UI on massive flat folders
					if (i > 0 && i % 100 === 0) {
						await new Promise(resolve => setTimeout(resolve, 0));
					}

					const fileName = file.split('/').pop() || '';

					// Skip ignored files
					if (this.isNameIgnored(fileName, mount)) continue;

					// Skip hidden files
					if (fileName.startsWith('.')) continue;

					if (!this.app.vault.getAbstractFileByPath(file)) {
						const stat = await this.app.vault.adapter.stat(file);
						await vault.onChange('file-created', file, null, stat);
						fileCount++;
					}
				}
			} catch (e) {
				console.debug(`FolderBridge: Failed to list ${folderPath}`, e);
			}
		};

		await recursivelyNotifyVault(normalizePath(mount.virtualPath));
		notice.hide();
		new Notice(`FolderBridge: Mounted ${folderCount} folders and ${fileCount} files in "${mount.virtualPath}"`);
		try {
			await vault.onChange('raw', normalizePath(mount.virtualPath), null, null);
		} catch (e) {
			console.debug('FolderBridge: vault.onChange(raw) unavailable', e);
		}

		// Force the file explorer to refresh the folder contents by expanding and collapsing it
		setTimeout(() => {
			const fileExplorerLeaves = this.app.workspace.getLeavesOfType('file-explorer');
			if (fileExplorerLeaves.length === 0) return;

			const fileExplorerView = fileExplorerLeaves[0].view as { fileItems: Record<string, { setCollapsed?: (collapsed: boolean) => void }> };
			const fileItems = fileExplorerView.fileItems;

			const folderPath = normalizePath(mount.virtualPath);
			if (fileItems && fileItems[folderPath]) {
				const folderItem = fileItems[folderPath];
				if (typeof folderItem.setCollapsed === 'function') {
					folderItem.setCollapsed(false);
				}
			}
		}, 100);
	}

	/**
	 * Remove a virtual mount folder from Obsidian's internal vault index
	 * so the file explorer stops showing it immediately after removal.
	 */
	async notifyVaultMountRemoved(mount: MountPoint): Promise<void> {
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
						await vault.onChange('file-removed', file, null, null);
					}
				}
				for (const folder of list.folders) {
					await recursivelyRemoveVault(folder);
					if (this.app.vault.getAbstractFileByPath(folder)) {
						await vault.onChange('folder-removed', folder, null, null);
					}
				}
			} catch (e) {
				console.debug(`FolderBridge: Failed to list ${folderPath} during removal`, e);
			}
		};

		await recursivelyRemoveVault(nPath);

		try {
			await vault.onChange('folder-removed', nPath, null, null);
		} catch (e) {
			console.debug('FolderBridge: vault.onChange(folder-removed) unavailable', e);
		}
	}

	// ------------------------------------------------------------------
	// Status bar
	// ------------------------------------------------------------------

	updateStatusBar(): void {
		if (!this.statusBarItem) return;
		const active = this.settings.mountPoints.filter(m => m.enabled).length;
		this.statusBarItem.setText(`FolderBridge: ${active} mount${active !== 1 ? 's' : ''}`);
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
		await this.saveData(this.settings);
		this.updateIgnoreCache();
	}
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class FolderBridgeSettingTab extends PluginSettingTab {
	plugin: FolderBridgePlugin;
	private selectedIgnoreMountId: string | null = null;

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
			.setName('FolderBridge')
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
		syncWarning.innerHTML = `<strong>⚠️ Sync Warning:</strong> If you use Obsidian Sync or Syncthing, you <strong>must</strong> add your virtual folder names to your sync ignore list (e.g. <code>.stignore</code> or Obsidian Sync Excluded Folders). Otherwise, your sync engine will try to upload the entire contents of your mounted folders!`;

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

		// ── Ignore Lists ─────────────────────────────────────────────────
		new Setting(containerEl).setName('Ignore Lists').setHeading();

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

					const inputEl = addContainer.createEl('input', { type: 'text', placeholder: 'Add new item (e.g. .DS_Store)' });
					inputEl.style.flexGrow = '1';

					const addBtn = addContainer.createEl('button', { text: 'Add' });
					addBtn.onclick = async () => {
						const val = inputEl.value.trim();
						if (val) {
							if (!selectedMount.ignoreList) selectedMount.ignoreList = [];
							if (!selectedMount.ignoreList.includes(val)) {
								selectedMount.ignoreList.push(val);
								await this.plugin.saveSettings();
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
				}));

		// Render each existing mount (status loaded async below)
		if (this.plugin.settings.mountPoints.length === 0) {
			containerEl.createEl('p', {
				text: 'No mounts configured yet. Click "Add Mount Point" to get started.',
				cls: 'setting-item-description',
			});
		}

		for (const mount of this.plugin.settings.mountPoints) {
			this.renderMountRow(containerEl, mount);
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
							new Notice('FolderBridge: Cannot enable a mount created on a different device.');
							return;
						}
						mount.enabled = val;
						await this.plugin.saveSettings();
						this.plugin.pathMapper.update(this.plugin.settings.mountPoints, this.plugin.settings.deviceId);
						this.plugin.updateStatusBar();
						// Inject into / remove from Obsidian's vault tree live
						if (val) {
							await this.plugin.notifyVaultMountAdded(mount);
						} else {
							await this.plugin.notifyVaultMountRemoved(mount);
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
						this.display();
						new Notice(`FolderBridge: Path overridden for this device.`);
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

		// Async status badge
		if (canEnable) {
			getMountStatus(mount).then(status => {
				const badge = status.reachable
					? (status.readOnly ? '[read-only]' : '[writable]')
					: `[error: ${status.error ?? 'unreachable'}]`;
				const prefix = status.reachable ? '✓' : '✗';
				setting.setName(`${prefix} ${displayName} ${badge}`);
			}).catch(() => { /* ignore render errors */ });
		} else {
			setting.setName(`[Other Device] ${displayName}`);
			setting.settingEl.style.opacity = '0.7';
		}
	}
}
