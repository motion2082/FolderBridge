import { App, Modal, Notice, Setting, SuggestModal, TFolder, TextComponent, normalizePath } from 'obsidian';
import * as path from 'path';
import { MountPoint, MountStatus } from '../types';
import { SecurityManager } from '../SecurityManager';
import { checkPathAccessible, isDirectory, getPlatform, isWSL } from '../OSHelpers';

// ---------------------------------------------------------------------------
// Electron folder-picker helper
// ---------------------------------------------------------------------------

/**
 * Open the native OS folder-picker dialog via Electron's remote API.
 * Returns the selected absolute path, or null if the user cancelled or the
 * Electron remote API is unavailable in the current host environment.
 */
export async function browseFolderOnDisk(title = 'Select Folder', defaultPath?: string): Promise<string | null> {
	try {
		// `electron` is declared external in esbuild so require() resolves to
		// the host Electron bundle, not a Node module.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const electron = (window as any).require?.('electron') ?? require('electron');
		// Electron ≥ 14 ships remote via @electron/remote; Obsidian re-exports
		// it on the electron object so both old and new versions work here.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const dialog: any = electron?.remote?.dialog ?? electron?.dialog;
		if (!dialog?.showOpenDialog) {
			new Notice('FolderBridge: Native folder browser is unavailable. Please type the path manually.');
			return null;
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const options: any = {
			properties: ['openDirectory'],
			title,
		};
		if (defaultPath) {
			options.defaultPath = defaultPath;
		}
		const result = await dialog.showOpenDialog(options);
		if (result.canceled || !result.filePaths?.length) return null;
		return result.filePaths[0] as string;
	} catch (err) {
		console.error('FolderBridge: Electron dialog error', err);
		new Notice('FolderBridge: Native folder browser is unavailable. Please type the path manually.');
		return null;
	}
}

// ---------------------------------------------------------------------------
// Vault folder picker modal
// ---------------------------------------------------------------------------

/**
 * A fuzzy-search modal that lists all TFolder nodes currently loaded in the
 * vault.  Used so the user can browse the vault hierarchy when choosing a
 * virtual parent path, rather than having to type it from memory.
 */
export class VaultFolderPickerModal extends SuggestModal<string> {
	private onChoose: (folderPath: string) => void;
	private folders: string[];

	constructor(app: App, onChoose: (folderPath: string) => void) {
		super(app);
		this.onChoose = onChoose;
		this.setPlaceholder('Type to search vault folders… (Enter on blank line = vault root)');
		// Build the folder list once so getSuggestions only filters, never enumerates
		this.folders = app.vault.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && f.path.length > 0)
			.map(f => f.path);
	}

	getSuggestions(query: string): string[] {
		const q = query.toLowerCase();
		const results: string[] = [];

		// Always offer the root as first option
		if (!q || '(vault root)'.includes(q)) {
			results.push('(vault root)');
		}

		for (const p of this.folders) {
			if (!q || p.toLowerCase().includes(q)) {
				results.push(p);
			}
		}
		return results;
	}

	renderSuggestion(item: string, el: HTMLElement): void {
		const container = el.createEl('div', { cls: 'vault-folder-suggestion' });

		if (item === '(vault root)') {
			container.addClass('vault-folder-suggestion-root');
			container.createSpan({ text: item, cls: 'vault-folder-suggestion-label' });
		} else {
			container.createSpan({ text: item, cls: 'vault-folder-suggestion-label' });
		}
	}

	onChooseSuggestion(item: string): void {
		this.onChoose(item === '(vault root)' ? '' : item);
	}
}

// ---------------------------------------------------------------------------
// Callback type
// ---------------------------------------------------------------------------

/** Callback invoked by the modal when the user successfully validates a mount. */
export type OnMountSave = (mount: Omit<MountPoint, 'id'>, editId?: string) => Promise<void>;

// ---------------------------------------------------------------------------
// MountManagerModal
// ---------------------------------------------------------------------------

/**
 * MountManagerModal lets the user configure a new mount point:
 *
 *  1. Real path  – absolute OS path, with a native "Browse…" folder picker
 *  2. Virtual path – vault-relative path, with a "Browse vault…" picker that
 *     shows existing vault folders for easy nesting
 *  3. Use folder name as label – auto-fills the label from the real path's
 *     base name whenever the real path changes (can still be overridden)
 *  4. Label – optional display name shown in settings instead of the path
 *  5. Read-only – block all writes through this mount
 */
export class MountManagerModal extends Modal {
	private onSave: OnMountSave;
	private security: SecurityManager;
	private editMount: MountPoint | undefined;

	// ── Form state ──────────────────────────────────────────────────────────
	private virtualPath = '';
	private realPath = '';
	private readOnly = false;
	private label = '';
	private useFolderNameAsLabel = false;
	// Advanced (per-mount watcher + performance)
	private watcherDebounceMs: number | undefined = undefined;
	private watcherUsePolling = false;
	private watcherPollingIntervalMs: number | undefined = undefined;
	private maxFiles: number | undefined = undefined;

	// ── Component references for programmatic updates ────────────────────────
	private virtualPathText: TextComponent | null = null;
	private realPathText: TextComponent | null = null;
	private labelText: TextComponent | null = null;

	constructor(app: App, security: SecurityManager, onSave: OnMountSave, editMount?: MountPoint) {
		super(app);
		this.security = security;
		this.onSave = onSave;
		this.editMount = editMount;
		// Pre-populate state from existing mount
		if (editMount) {
			this.virtualPath = editMount.virtualPath;
			this.realPath = editMount.realPath;
			this.readOnly = editMount.readOnly;
			this.label = editMount.label ?? '';
			this.watcherDebounceMs = editMount.watcherDebounceMs;
			this.watcherUsePolling = editMount.watcherUsePolling ?? false;
			this.watcherPollingIntervalMs = editMount.watcherPollingIntervalMs;
			this.maxFiles = editMount.maxFiles;
		}
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: this.editMount ? 'Edit Mount Point' : 'Add Mount Point' });

		const platform = getPlatform();
		const wsl = isWSL();

		// Choose a platform-appropriate placeholder for the real path
		let realPlaceholder: string;
		if (platform === 'windows') {
			realPlaceholder = 'C:\\Users\\YourName\\Documents\\Work';
		} else if (wsl) {
			realPlaceholder = '/home/yourname/docs   or   /mnt/c/Users/YourName/docs';
		} else {
			realPlaceholder = '/home/yourname/Documents/Work';
		}

		// ── Real path ──────────────────────────────────────────────────────
		const realPathSetting = new Setting(contentEl)
			.setName('Real path (on disk)')
			.setDesc('Absolute path to the external folder you want to mount')
			.addText(text => {
				this.realPathText = text;
				text.inputEl.style.flex = '1';
				text.setPlaceholder(realPlaceholder)
					.setValue(this.realPath)
					.onChange(val => {
						this.realPath = val.trim();
						this.syncAutoLabel();
					});
			})
			.addButton(btn => {
				btn.setButtonText('Browse…')
					.setTooltip('Open the system folder picker')
					.onClick(async () => {
						const selected = await browseFolderOnDisk('Select External Folder');
						if (selected) {
							this.realPath = selected;
							this.realPathText?.setValue(selected);
							this.syncAutoLabel();
						}
					});
				btn.buttonEl.setAttribute('aria-label', 'Browse for folder on disk');
			});

		if (platform === 'windows') {
			realPathSetting.addButton(btn => {
				btn.setButtonText('Browse WSL…')
					.setTooltip('Open the system folder picker directly to your WSL Linux distributions')
					.onClick(async () => {
						const selected = await browseFolderOnDisk('Select WSL Folder', '\\\\wsl.localhost');
						if (selected) {
							this.realPath = selected;
							this.realPathText?.setValue(selected);
							this.syncAutoLabel();
						}
					});
				btn.buttonEl.setAttribute('aria-label', 'Browse for WSL folder');
			});
		}

		// WSL context hints
		if (platform === 'windows') {
			contentEl.createEl('p', {
				text: 'WSL tip: To mount a Linux (WSL 2) folder in Windows Obsidian, use ' +
					'\\\\wsl.localhost\\<Distro>\\path (Windows 11 / Win 10 21H1+) ' +
					'or \\\\wsl$\\<Distro>\\path (older Windows 10). ' +
					'You can type either path in the Browse dialog address bar.',
				cls: 'setting-item-description',
			});
		} else if (wsl) {
			contentEl.createEl('p', {
				text: 'WSL tip: Windows drives are accessible at /mnt/c/, /mnt/d/, etc. ' +
					'To let Windows-side Obsidian see this folder, use ' +
					'\\\\wsl.localhost\\<Distro>\\path (Windows 11 / Win 10 21H1+) ' +
					'or \\\\wsl$\\<Distro>\\path (older Windows 10).',
				cls: 'setting-item-description',
			});
		}

		// ── Virtual path ───────────────────────────────────────────────────
		new Setting(contentEl)
			.setName('Virtual path (in vault)')
			.setDesc(
				'Where this folder will appear inside your vault, e.g. "Projects/Work". ' +
				'Use "Browse vault…" to pick an existing vault folder as the parent, ' +
				'then refine the leaf name. Leave empty to use the real folder\'s name at the vault root.'
			)
			.addText(text => {
				this.virtualPathText = text;
				text.inputEl.style.flex = '1';
				text.setPlaceholder('Projects/Work')
					.setValue(this.virtualPath)
					.onChange(val => { this.virtualPath = val.trim(); });
			})
			.addButton(btn => {
				btn.setButtonText('Browse vault…')
					.setTooltip('Pick an existing vault folder as the parent directory')
					.onClick(() => {
						new VaultFolderPickerModal(this.app, (chosen) => {
							// `chosen` is '' for vault root, or an existing folder path.
							// Preserve any leaf name the user already typed; if empty,
							// default to the real folder's base name.
							const trimmedVirtualPath = this.virtualPath.trim();
							const existingLeaf = trimmedVirtualPath
								? path.posix.basename(trimmedVirtualPath)
								: '';
							const leaf = existingLeaf || (this.realPath ? path.basename(this.realPath) : '');
							const combined = chosen
								? normalizePath(`${chosen}/${leaf}`)
								: leaf;
							this.virtualPath = combined;
							this.virtualPathText?.setValue(combined);
						}).open();
					});
				btn.buttonEl.setAttribute('aria-label', 'Browse vault folders');
			});

		// ── Use folder name as label ───────────────────────────────────────
		new Setting(contentEl)
			.setName('Use folder name as label')
			.setDesc(
				'Automatically fill the label below with the real folder\'s name. ' +
				'The label is what appears in the settings panel instead of the full path.'
			)
			.addToggle(toggle => toggle
				.setValue(false)
				.onChange(val => {
					this.useFolderNameAsLabel = val;
					// Only auto-fill when enabling the toggle and the label is currently empty
					if (val) {
						const currentLabel =
							(this.labelText?.getValue?.() ?? this.label ?? '').trim();
						if (!currentLabel) {
							this.syncAutoLabel();
						}
					}
				}));

		// ── Label ──────────────────────────────────────────────────────────
		new Setting(contentEl)
			.setName('Label (optional)')
			.setDesc('Display name shown in the settings panel instead of the virtual path')
			.addText(text => {
				this.labelText = text;
				text.setPlaceholder('My Work Documents')
					.setValue(this.label)
					.onChange(val => { this.label = val.trim(); });
			});

		// ── Read-only ──────────────────────────────────────────────────────
		new Setting(contentEl)
			.setName('Read-only')
			.setDesc('When enabled, FolderBridge will refuse any write operations to this mount')
			.addToggle(toggle => toggle
				.setValue(this.readOnly)
				.onChange(val => { this.readOnly = val; }));
		// ── Advanced (collapsible) ─────────────────────────────────────────────
		const details = contentEl.createEl('details', { cls: 'folderbridge-advanced' });
		details.style.marginTop = '12px';
		details.style.marginBottom = '8px';
		details.style.border = '1px solid var(--background-modifier-border)';
		details.style.borderRadius = '4px';
		details.style.padding = '0 10px';
		const summary = details.createEl('summary', { text: 'Advanced settings' });
		summary.style.cursor = 'pointer';
		summary.style.padding = '8px 0';
		summary.style.fontWeight = '600';
		summary.style.color = 'var(--text-muted)';

		const advancedContainer = details.createDiv();
		advancedContainer.style.paddingBottom = '8px';

		new Setting(advancedContainer)
			.setName('Debounce threshold (ms)')
			.setDesc('How long to wait after the last change event before notifying Obsidian. Increase for editors that save very frequently. (Default: 300)')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '50';
				text.inputEl.max = '5000';
				text.inputEl.style.width = '80px';
				text.setPlaceholder('300')
					.setValue(this.watcherDebounceMs != null ? String(this.watcherDebounceMs) : '')
					.onChange(val => {
						const n = parseInt(val, 10);
						this.watcherDebounceMs = isNaN(n) || n <= 0 ? undefined : Math.min(5000, Math.max(50, n));
					});
			});

		let pollingIntervalSetting: Setting | null = null;

		const showHidePollingInterval = (show: boolean) => {
			if (pollingIntervalSetting) {
				pollingIntervalSetting.settingEl.style.display = show ? '' : 'none';
			}
		};

		new Setting(advancedContainer)
			.setName('Use polling')
			.setDesc('Poll for changes instead of native OS events. Required for NAS and network drives that do not support inotify / ReadDirectoryChangesW.')
			.addToggle(toggle => toggle
				.setValue(this.watcherUsePolling)
				.onChange(val => {
					this.watcherUsePolling = val;
					showHidePollingInterval(val);
				}));

		pollingIntervalSetting = new Setting(advancedContainer)
			.setName('Polling interval (ms)')
			.setDesc('How often to poll the filesystem for changes. Only effective when "Use polling" is on. (Default: 2000)')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '500';
				text.inputEl.max = '60000';
				text.inputEl.style.width = '80px';
				text.setPlaceholder('2000')
					.setValue(this.watcherPollingIntervalMs != null ? String(this.watcherPollingIntervalMs) : '')
					.onChange(val => {
						const n = parseInt(val, 10);
						this.watcherPollingIntervalMs = isNaN(n) || n <= 0 ? undefined : Math.min(60000, Math.max(500, n));
					});
			});
		showHidePollingInterval(this.watcherUsePolling);

		new Setting(advancedContainer)
			.setName('Max files (scan limit)')
			.setDesc('Stop the initial vault scan after this many items. Leave blank for unlimited. Use this to keep Obsidian responsive with very large mounts.')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text.inputEl.style.width = '100px';
				text.setPlaceholder('unlimited')
					.setValue(this.maxFiles != null ? String(this.maxFiles) : '')
					.onChange(val => {
						const n = parseInt(val, 10);
						this.maxFiles = isNaN(n) || n <= 0 ? undefined : n;
					});
			});
		// ── Action buttons ─────────────────────────────────────────────────
		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText(this.editMount ? 'Save Changes' : 'Validate & Add')
				.setCta()
				.onClick(() => { this.handleSave().catch(console.error); }))
			.addButton(btn => btn
				.setButtonText('Cancel')
				.onClick(() => this.close()));
	}

	// ------------------------------------------------------------------
	// Helpers
	// ------------------------------------------------------------------

	/**
	 * If "use folder name as label" is active, overwrite the label field
	 * with the basename of the current real path.
	 */
	private syncAutoLabel(): void {
		if (!this.useFolderNameAsLabel) return;
		const name = this.realPath ? path.basename(this.realPath) : '';
		this.label = name;
		this.labelText?.setValue(name);
	}

	// ------------------------------------------------------------------
	// Save / validation
	// ------------------------------------------------------------------

	private async handleSave(): Promise<void> {
		// Fall back to the real folder's base name when no virtual path was typed
		const virtualPathToUse = this.virtualPath.trim()
			|| (this.realPath ? path.basename(this.realPath) : '');

		if (!virtualPathToUse) {
			new Notice('FolderBridge: Virtual path is required.');
			return;
		}
		if (!this.realPath) {
			new Notice('FolderBridge: Real path is required.');
			return;
		}
		if (!path.isAbsolute(this.realPath)) {
			new Notice('FolderBridge: Real path must be an absolute filesystem path.');
			return;
		}

		const normalizedVirtual = normalizePath(virtualPathToUse);

		// Validate via SecurityManager (dangerous paths, duplicate mounts, etc.)
		const validationError = this.security.validateMount(
			{
				virtualPath: normalizedVirtual,
				realPath: this.realPath,
				enabled: true,
				readOnly: this.readOnly,
				label: this.label || undefined,
			},
			[], // Full existing-mount check is done again by the plugin's addMount() / updateMount()
		);
		if (validationError) {
			new Notice(`FolderBridge: ${validationError}`);
			return;
		}

		// Only re-check accessibility when the real path has changed (or this is a new mount)
		const realPathChanged = !this.editMount || this.editMount.realPath !== this.realPath;
		if (realPathChanged) {
			const dirExists = await isDirectory(this.realPath);
			if (!dirExists) {
				new Notice(`FolderBridge: "${this.realPath}" is not an accessible directory.`);
				return;
			}

			const { accessible, error } = await checkPathAccessible(this.realPath);
			if (!accessible) {
				new Notice(`FolderBridge: Cannot access "${this.realPath}": ${error}`);
				return;
			}
		}

		// Non-blocking advisory warnings (e.g. UNC / network paths)
		const warnings = this.security.getPathWarnings(this.realPath);
		for (const w of warnings) {
			new Notice(`FolderBridge warning: ${w}`, 10_000);
		}

		await this.onSave(
			{
				virtualPath: normalizedVirtual,
				realPath: this.realPath,
				enabled: this.editMount ? this.editMount.enabled : true,
				readOnly: this.readOnly,
				label: this.label || undefined,
				watcherDebounceMs: this.watcherDebounceMs,
				watcherUsePolling: this.watcherUsePolling || undefined,
				watcherPollingIntervalMs: this.watcherUsePolling ? this.watcherPollingIntervalMs : undefined,
				maxFiles: this.maxFiles,
			},
			this.editMount?.id,
		);

		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------------------
// Status helpers used in the settings tab
// ---------------------------------------------------------------------------

/**
 * Query the live reachability and permission status of a mount point.
 * Called when the settings tab renders the mount list.
 */
export async function getMountStatus(mount: MountPoint): Promise<MountStatus> {
	const { accessible, readOnly, error } = await checkPathAccessible(mount.realPath);
	return {
		mount,
		reachable: accessible,
		readOnly: mount.readOnly || readOnly,
		error,
	};
}
