import { App, Modal, Notice, Setting, normalizePath } from 'obsidian';
import * as path from 'path';
import { MountPoint, MountStatus } from '../types';
import { SecurityManager } from '../SecurityManager';
import { checkPathAccessible, isDirectory, getPlatform } from '../OSHelpers';

// Callback type used by the modal to return a new mount to the plugin
export type OnMountSave = (mount: Omit<MountPoint, 'id'>) => Promise<void>;

/**
 * MountManagerModal lets users add a new mount point by specifying:
 *  - A virtual path inside the vault (e.g. "Projects/Work")
 *  - An absolute real path on disk (e.g. "/home/user/Documents/Work")
 *  - Optional: read-only flag, display label
 *
 * The modal validates the paths before calling the onSave callback.
 */
export class MountManagerModal extends Modal {
	private onSave: OnMountSave;
	private security: SecurityManager;

	// Form fields
	private virtualPath = '';
	private realPath = '';
	private readOnly = false;
	private label = '';

	constructor(app: App, security: SecurityManager, onSave: OnMountSave) {
		super(app);
		this.security = security;
		this.onSave = onSave;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Add Mount Point' });

		// Platform hint
		const placeholder = getPlatform() === 'windows'
			? 'C:\\Users\\YourName\\Documents\\Work'
			: '/home/yourname/Documents/Work';

		new Setting(contentEl)
			.setName('Virtual path (in vault)')
			.setDesc('Where the external folder will appear inside your vault, e.g. "Projects/Work"')
			.addText(text => {
				text.setPlaceholder('Projects/Work')
					.onChange(val => { this.virtualPath = val.trim(); });
			});

		new Setting(contentEl)
			.setName('Real path (on disk)')
			.setDesc('Absolute path to the external folder on your filesystem')
			.addText(text => {
				text.setPlaceholder(placeholder)
					.onChange(val => { this.realPath = val.trim(); });
			});

		new Setting(contentEl)
			.setName('Read-only')
			.setDesc('When enabled, FolderBridge will refuse any write operations to this mount')
			.addToggle(toggle => {
				toggle.setValue(false)
					.onChange(val => { this.readOnly = val; });
			});

		new Setting(contentEl)
			.setName('Label (optional)')
			.setDesc('Display name shown in the settings panel instead of the virtual path')
			.addText(text => {
				text.setPlaceholder('My Work Documents')
					.onChange(val => { this.label = val.trim(); });
			});

		// Buttons row
		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Validate & Add')
				.setCta()
				.onClick(() => { this.handleSave().catch(console.error); }))
			.addButton(btn => btn
				.setButtonText('Cancel')
				.onClick(() => this.close()));
	}

	private async handleSave(): Promise<void> {
		if (!this.virtualPath) {
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

		// Validate via SecurityManager (checks dangerous paths, duplicates, etc.)
		const validationError = this.security.validateMount(
			{
				virtualPath: normalizePath(this.virtualPath),
				realPath: this.realPath,
				enabled: true,
				readOnly: this.readOnly,
				label: this.label || undefined,
			},
			[] // Existing mounts are checked by the plugin itself
		);
		if (validationError) {
			new Notice(`FolderBridge: ${validationError}`);
			return;
		}

		const accessible = await isDirectory(this.realPath);
		if (!accessible) {
			new Notice(`FolderBridge: "${this.realPath}" is not an accessible directory.`);
			return;
		}

		const { accessible: canAccess, error } = await checkPathAccessible(this.realPath);
		if (!canAccess) {
			new Notice(`FolderBridge: Cannot access "${this.realPath}": ${error}`);
			return;
		}

		// Show non-blocking advisory warnings (e.g. UNC/network paths) before closing
		const warnings = this.security.getPathWarnings(this.realPath);
		for (const w of warnings) {
			new Notice(`FolderBridge warning: ${w}`, 10000);
		}

		await this.onSave({
			virtualPath: normalizePath(this.virtualPath),
			realPath: this.realPath,
			enabled: true,
			readOnly: this.readOnly,
			label: this.label || undefined,
		});

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
