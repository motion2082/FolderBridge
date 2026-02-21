import { App, Plugin, PluginSettingTab, Setting, Notice, normalizePath } from 'obsidian';
import { FolderBridgeSettings, MountPoint, DEFAULT_SETTINGS } from './src/types';
import { PathMapper } from './src/PathMapper';
import { VirtualAdapter } from './src/VirtualAdapter';
import { SecurityManager } from './src/SecurityManager';
import { MountManagerModal, getMountStatus } from './src/ui/MountManagerModal';
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
		this.pathMapper.update(this.settings.mountPoints);

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

		// After the workspace finishes loading, inject all enabled mounts into
		// Obsidian's internal vault file tree so they appear in the file explorer
		// without requiring a restart.
		this.app.workspace.onLayoutReady(async () => {
			for (const mount of this.settings.mountPoints.filter(m => m.enabled)) {
				await this.notifyVaultMountAdded(mount);
			}
		});

		console.log(`FolderBridge loaded (${getPlatform()}, ${this.settings.mountPoints.filter(m => m.enabled).length} active mounts)`);
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

		const mount: MountPoint = { ...mountData, id: generateId() };
		this.settings.mountPoints.push(mount);

		// Register in allowlist if not already present
		if (!this.settings.allowlist.includes(mount.realPath)) {
			this.settings.allowlist.push(mount.realPath);
			this.security.allow(mount.realPath);
		}

		await this.saveSettings();
		this.pathMapper.update(this.settings.mountPoints);
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
		this.pathMapper.update(this.settings.mountPoints);
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
		if (typeof vault.onChange !== 'function') return;

		// Walk every path segment so intermediate virtual folders also appear
		// (e.g. mounting "Projects/Work" also surfaces the "Projects" folder).
		const segments = normalizePath(mount.virtualPath).split('/');
		for (let i = 1; i <= segments.length; i++) {
			const partPath = segments.slice(0, i).join('/');
			// Skip segments Obsidian already knows about
			if (this.app.vault.getAbstractFileByPath(partPath)) continue;
			try {
				await vault.onChange('created', partPath, null, null);
			} catch (e) {
				console.debug('FolderBridge: vault.onChange(created) unavailable', e);
			}
		}
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
		try {
			await vault.onChange('deleted', nPath, null, null);
		} catch (e) {
			console.debug('FolderBridge: vault.onChange(deleted) unavailable', e);
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
		// Back-compat: assign ids to mounts created before the id field existed
		for (const m of this.settings.mountPoints) {
			if (!m.id) m.id = generateId();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class FolderBridgeSettingTab extends PluginSettingTab {
	plugin: FolderBridgePlugin;

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

		containerEl.createEl('p', {
			text: `Platform: ${getPlatform()}`,
			cls: 'setting-item-description',
		});

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
		const displayName = mount.label || mount.virtualPath;
		const desc = `${normalizePath(mount.virtualPath)} → ${mount.realPath}`;

		const setting = new Setting(containerEl)
			.setName(`${displayName}`)
			.setDesc(desc)
			.addToggle(toggle => toggle
				.setValue(mount.enabled)
				.setTooltip('Enable / disable this mount')
				.onChange(async val => {
					mount.enabled = val;
					await this.plugin.saveSettings();
					this.plugin.pathMapper.update(this.plugin.settings.mountPoints);
					this.plugin.updateStatusBar();
					// Inject into / remove from Obsidian's vault tree live
					if (val) {
						await this.plugin.notifyVaultMountAdded(mount);
					} else {
						await this.plugin.notifyVaultMountRemoved(mount);
					}
				}))
			.addButton(btn => btn
				.setButtonText('Remove')
				.setWarning()
				.onClick(async () => {
					await this.plugin.removeMount(mount.id);
					this.display();
				}));

		// Async status badge
		getMountStatus(mount).then(status => {
			const badge = status.reachable
				? (status.readOnly ? '[read-only]' : '[writable]')
				: `[error: ${status.error ?? 'unreachable'}]`;
			const prefix = status.reachable ? '✓' : '✗';
			setting.setName(`${prefix} ${displayName} ${badge}`);
		}).catch(() => { /* ignore render errors */ });
	}
}
