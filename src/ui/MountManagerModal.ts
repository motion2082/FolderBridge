import { App, Modal, Notice, Platform, Setting, SuggestModal, TFolder, TextComponent, normalizePath } from 'obsidian';
import { MountPoint, MountStatus, MountType } from '../types';
import { SecurityManager } from '../SecurityManager';
import { checkPathAccessible, isDirectory, getPlatform, isWSL } from '../OSHelpers';

// Lazy-loaded — unavailable on Obsidian Mobile (Capacitor).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const path: typeof import('path') = (() => { try { return (require as any)('path'); } catch { return null as never; } })();

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
			new Notice('Folder Bridge: Native folder browser is unavailable. Please type the path manually.');
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
		console.error('Folder Bridge: Electron dialog error', err);
		new Notice('Folder Bridge: Native folder browser is unavailable. Please type the path manually.');
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
	private mountType: MountType = 'local';
	private virtualPath = '';
	private realPath = '';
	private readOnly = false;
	private label = '';
	private useFolderNameAsLabel = false;
	// WebDAV fields (password never persisted to data.json)
	private webdavUrl = '';
	private webdavUsername = '';
	private webdavPassword = '';
	// S3 / Backblaze B2 fields
	private s3Bucket = '';
	private s3Region = '';
	private s3Endpoint = '';
	private s3AccessKeyId = '';
	private s3SecretKey = '';
	private s3ForcePathStyle = false;
	private s3Prefix = '/';
	// SFTP fields
	private sftpHost = '';
	private sftpPort = 22;
	private sftpUsername = '';
	private sftpPassword = '';
	private sftpPrivateKeyPath = '';
	private sftpPassphrase = '';
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
			this.mountType = editMount.mountType ?? 'local';
			this.virtualPath = editMount.virtualPath;
			this.realPath = editMount.realPath;
			this.readOnly = editMount.readOnly;
			this.label = editMount.label ?? '';
			// WebDAV
			this.webdavUrl = editMount.webdavUrl ?? '';
			this.webdavUsername = editMount.webdavUsername ?? '';
			// Password is never stored — leave blank; user re-enters to change
			// S3
			this.s3Bucket = editMount.s3Bucket ?? '';
			this.s3Region = editMount.s3Region ?? '';
			this.s3Endpoint = editMount.s3Endpoint ?? '';
			this.s3AccessKeyId = editMount.s3AccessKeyId ?? '';
			this.s3ForcePathStyle = editMount.s3ForcePathStyle ?? false;
			this.s3Prefix = editMount.realPath || '/';
			// SFTP
			this.sftpHost = editMount.sftpHost ?? '';
			this.sftpPort = editMount.sftpPort ?? 22;
			this.sftpUsername = editMount.sftpUsername ?? '';
			this.sftpPrivateKeyPath = editMount.sftpPrivateKeyPath ?? '';
			// Passwords/passphrases never stored — leave blank
			// Advanced watcher
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

		const isMobile = Platform.isMobile;
		const platform = getPlatform();
		const wsl = isWSL();

		// On mobile, only WebDAV mounts are supported (no local fs access).
		if (isMobile && this.mountType !== 'webdav') {
			this.mountType = 'webdav';
		}

		// ── Mount type selector ─────────────────────────────────────────────
		const localSection = contentEl.createDiv();
		const vaultSection = contentEl.createDiv();
		const webdavSection = contentEl.createDiv();
		const s3Section = contentEl.createDiv();
		const sftpSection = contentEl.createDiv();

		const toggleSections = (type: MountType) => {
			this.mountType = type;
			localSection.style.display = type === 'local' ? '' : 'none';
			vaultSection.style.display = type === 'vault' ? '' : 'none';
			webdavSection.style.display = type === 'webdav' ? '' : 'none';
			s3Section.style.display = type === 's3' ? '' : 'none';
			sftpSection.style.display = type === 'sftp' ? '' : 'none';
		};

		if (isMobile) {
			// On mobile, only WebDAV and S3 mounts are supported
			contentEl.createEl('p', {
				text: 'On mobile, only WebDAV and S3 mounts are supported. Local filesystem, vault, and SFTP mounts require Obsidian Desktop.',
				cls: 'setting-item-description',
			});
			contentEl.createEl('p', {
				text: 'To access local files on this device, install a WebDAV server app (e.g. CX File Explorer) and connect to http://localhost:PORT/',
				cls: 'setting-item-description',
			});
			new Setting(contentEl)
				.setName('Mount type')
				.addDropdown(drop => drop
					.addOption('webdav', 'WebDAV (Nextcloud, ownCloud, generic)')
					.addOption('s3', 'Amazon S3 / Backblaze B2')
					.setValue(this.mountType === 's3' ? 's3' : 'webdav')
					.onChange(val => toggleSections(val as MountType)));
			toggleSections(this.mountType === 's3' ? 's3' : 'webdav');
		} else {
			new Setting(contentEl)
				.setName('Mount type')
				.setDesc('Choose the storage backend for this mount point')
				.addDropdown(drop => drop
					.addOption('local', 'Local filesystem')
					.addOption('vault', 'Another Obsidian vault')
					.addOption('webdav', 'WebDAV (Nextcloud, ownCloud, generic)')
					.addOption('s3', 'Amazon S3 / Backblaze B2')
					.addOption('sftp', 'SFTP (SSH file transfer)')
					.setValue(this.mountType)
					.onChange(val => toggleSections(val as MountType)));
			toggleSections(this.mountType);
		} // end else (desktop only)

		// ── Vault section (shown when type === 'vault') ────────────────────
		vaultSection.createEl('p', {
			text: 'Bridge to another Obsidian vault on this device. The vault\'s .obsidian configuration folder and .trash are automatically excluded. ' +
				'Notes and attachments from the other vault appear as regular files in your current vault.',
			cls: 'setting-item-description',
		});
		vaultSection.style.marginBottom = '8px';

		let vaultPathText: TextComponent | null = null;
		new Setting(vaultSection)
			.setName('Other vault root folder')
			.setDesc('Absolute path to the root of the other Obsidian vault')
			.addText(text => {
				vaultPathText = text;
				text.inputEl.style.flex = '1';
				text.setPlaceholder(platform === 'windows' ? 'C:\\Users\\YourName\\MyOtherVault' : '/home/yourname/MyOtherVault')
					.setValue(this.mountType === 'vault' ? this.realPath : '')
					.onChange(val => {
						this.realPath = val.trim();
						this.syncAutoLabel();
					});
			})
			.addButton(btn => {
				btn.setButtonText('Browse…')
					.setTooltip('Open the system folder picker')
					.onClick(async () => {
						const selected = await browseFolderOnDisk('Select Other Vault Root');
						if (selected) {
							this.realPath = selected;
							vaultPathText?.setValue(selected);
							this.syncAutoLabel();
						}
					});
			});

		// ── WebDAV fields (shown when type === 'webdav') ───────────────────

		/* Quick-fill presets — selecting one pre-populates Server URL so users
		 * don't have to remember the /remote.php/dav/files/USERNAME/ pattern. */
		const WEBDAV_PRESETS: Record<string, { urlTemplate: string; note: string }> = {
			nextcloud:  { urlTemplate: 'https://cloud.example.com/remote.php/dav/files/YOUR_USERNAME', note: 'Replace cloud.example.com and YOUR_USERNAME with your values.' },
			owncloud:   { urlTemplate: 'https://cloud.example.com/remote.php/dav/files/YOUR_USERNAME', note: 'Replace cloud.example.com and YOUR_USERNAME with your values.' },
			synology:   { urlTemplate: 'https://nas.example.com/webdav',  note: 'Enable WebDAV in Synology Control Panel → File Services → WebDAV.' },
			qnap:       { urlTemplate: 'https://nas.example.com:8080/webdav', note: 'Enable WebDAV in QNAP Control Panel → Web Server → WebDAV Server.' },
		};

		let presetNoteEl: HTMLParagraphElement | null = null;
		let webdavUrlText: import('obsidian').TextComponent | null = null;

		if (!this.editMount) {
			new Setting(webdavSection)
				.setName('Quick-fill preset')
				.setDesc('Optionally choose your service to pre-fill the Server URL field below.')
				.addDropdown(drop => {
					drop.addOption('', '— select a preset —');
					drop.addOption('nextcloud', 'Nextcloud');
					drop.addOption('owncloud',  'ownCloud');
					drop.addOption('synology',  'Synology NAS (DSM WebDAV)');
					drop.addOption('qnap',      'QNAP NAS');
					drop.setValue('');
					drop.onChange(val => {
						const preset = WEBDAV_PRESETS[val];
						if (!preset) return;
						if (webdavUrlText) {
							webdavUrlText.setValue(preset.urlTemplate);
							this.webdavUrl = preset.urlTemplate;
						}
						if (!presetNoteEl) {
							presetNoteEl = webdavSection.createEl('p', { cls: 'setting-item-description' });
							presetNoteEl.style.marginTop = '-4px';
							presetNoteEl.style.marginBottom = '8px';
							presetNoteEl.style.color = 'var(--text-accent)';
						}
						presetNoteEl.setText('💡 ' + preset.note);
					});
				});
		}

		new Setting(webdavSection)
			.setName('WebDAV server URL')
			.setDesc('Full URL to the WebDAV endpoint, e.g. https://cloud.example.com/remote.php/dav/files/username')
			.addText(text => {
				webdavUrlText = text;
				text.inputEl.style.flex = '1';
				text.setPlaceholder('https://cloud.example.com/remote.php/dav/files/username')
					.setValue(this.webdavUrl)
					.onChange(val => { this.webdavUrl = val.trim(); });
			});

		new Setting(webdavSection)
			.setName('Remote base path')
			.setDesc('Path on the WebDAV server to use as the mount root, e.g. / or /Documents. Use / for the server root.')
			.addText(text => {
				text.inputEl.style.flex = '1';
				text.setPlaceholder('/')
					.setValue(this.mountType === 'webdav' ? (this.realPath || '/') : '/')
					.onChange(val => { this.realPath = val.trim() || '/'; });
			});

		new Setting(webdavSection)
			.setName('Username')
			.addText(text => {
				text.inputEl.style.flex = '1';
				text.setPlaceholder('your-username')
					.setValue(this.webdavUsername)
					.onChange(val => { this.webdavUsername = val.trim(); });
			});

		new Setting(webdavSection)
			.setName('Password')
			.setDesc(this.editMount?.mountType === 'webdav'
				? (this.editMount.encryptedWebdavPassword
					? 'Saved securely on this device. Leave blank to keep, or enter a new value to replace.'
					: 'Leave blank to keep the existing password. Enter a new value to replace it.')
				: 'Encrypted and saved on this device — survives Obsidian restarts.')
			.addText(text => {
				text.inputEl.type = 'password';
				text.inputEl.style.flex = '1';
				const hasStored = !!(this.editMount?.encryptedWebdavPassword);
				text.setPlaceholder(hasStored ? '(saved — leave blank to keep)' : this.editMount?.mountType === 'webdav' ? '(unchanged)' : 'password')
					.setValue('')
					.onChange(val => { this.webdavPassword = val; });
			});

		// ── S3 / Backblaze B2 section ──────────────────────────────────────
		s3Section.createEl('p', {
			text: 'Mount an Amazon S3 bucket or a Backblaze B2 bucket via the S3-compatible API. ' +
				'Files appear as regular notes in your vault. Note: S3 has no native folder rename — ' +
				'renames are implemented as copy + delete, which may be slow for large directories.',
			cls: 'setting-item-description',
		});

		const S3_PRESETS: Record<string, { region: string; endpoint: string; forcePathStyle: boolean; note: string }> = {
			aws:       { region: 'us-east-1', endpoint: '', forcePathStyle: false, note: 'Use an IAM user with S3 read/write permissions. Access Key ID + Secret Access Key.' },
			b2:        { region: 'us-west-004', endpoint: 'https://s3.us-west-004.backblazeb2.com', forcePathStyle: true, note: 'Use a Backblaze Application Key with read/write access to your bucket. Set endpoint to your bucket region.' },
			minio:     { region: 'us-east-1', endpoint: 'http://localhost:9000', forcePathStyle: true, note: 'Self-hosted MinIO. Path-style is required. Set endpoint to your MinIO URL.' },
			cloudflare:{ region: 'auto', endpoint: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com', forcePathStyle: false, note: 'Cloudflare R2. Replace <ACCOUNT_ID> with your Cloudflare account ID.' },
		};

		let s3PresetNoteEl: HTMLParagraphElement | null = null;
		let s3RegionText: import('obsidian').TextComponent | null = null;
		let s3EndpointText: import('obsidian').TextComponent | null = null;
		let s3PathStyleToggle: import('obsidian').ToggleComponent | null = null;

		if (!this.editMount) {
			new Setting(s3Section)
				.setName('Quick-fill preset')
				.setDesc('Choose your S3-compatible service to pre-fill fields below.')
				.addDropdown(drop => {
					drop.addOption('', '— select a preset —');
					drop.addOption('aws', 'Amazon S3');
					drop.addOption('b2', 'Backblaze B2');
					drop.addOption('minio', 'MinIO (self-hosted)');
					drop.addOption('cloudflare', 'Cloudflare R2');
					drop.setValue('');
					drop.onChange(val => {
						const preset = S3_PRESETS[val];
						if (!preset) return;
						this.s3Region = preset.region;
						this.s3Endpoint = preset.endpoint;
						this.s3ForcePathStyle = preset.forcePathStyle;
						s3RegionText?.setValue(preset.region);
						s3EndpointText?.setValue(preset.endpoint);
						s3PathStyleToggle?.setValue(preset.forcePathStyle);
						if (!s3PresetNoteEl) {
							s3PresetNoteEl = s3Section.createEl('p', { cls: 'setting-item-description' });
							s3PresetNoteEl.style.marginTop = '-4px';
							s3PresetNoteEl.style.marginBottom = '8px';
							s3PresetNoteEl.style.color = 'var(--text-accent)';
						}
						s3PresetNoteEl.setText(preset.note);
					});
				});
		}

		new Setting(s3Section)
			.setName('Bucket name')
			.setDesc('The S3 bucket or B2 bucket name (case-sensitive)')
			.addText(text => {
				text.inputEl.style.flex = '1';
				text.setPlaceholder('my-obsidian-bucket')
					.setValue(this.s3Bucket)
					.onChange(val => { this.s3Bucket = val.trim(); });
			});

		new Setting(s3Section)
			.setName('Region')
			.setDesc('AWS region (e.g. us-east-1) or B2 region string (e.g. us-west-004)')
			.addText(text => {
				s3RegionText = text;
				text.inputEl.style.flex = '1';
				text.setPlaceholder('us-east-1')
					.setValue(this.s3Region)
					.onChange(val => { this.s3Region = val.trim(); });
			});

		new Setting(s3Section)
			.setName('Custom endpoint URL (optional)')
			.setDesc('Leave empty for AWS S3. For Backblaze B2 set to your region endpoint, e.g. https://s3.us-west-004.backblazeb2.com')
			.addText(text => {
				s3EndpointText = text;
				text.inputEl.style.flex = '1';
				text.setPlaceholder('https://s3.us-west-004.backblazeb2.com  (leave blank for AWS)')
					.setValue(this.s3Endpoint)
					.onChange(val => { this.s3Endpoint = val.trim(); });
			});

		new Setting(s3Section)
			.setName('Key prefix / path')
			.setDesc('Optional folder prefix inside the bucket to use as the mount root, e.g. / for bucket root or /notes/ for a sub-folder.')
			.addText(text => {
				text.inputEl.style.flex = '1';
				text.setPlaceholder('/')
					.setValue(this.s3Prefix)
					.onChange(val => { this.s3Prefix = val.trim() || '/'; });
			});

		new Setting(s3Section)
			.setName('Access key ID')
			.setDesc('IAM Access Key ID (AWS) or Application Key ID (Backblaze B2)')
			.addText(text => {
				text.inputEl.style.flex = '1';
				text.setPlaceholder('AKIAIOSFODNN7EXAMPLE')
					.setValue(this.s3AccessKeyId)
					.onChange(val => { this.s3AccessKeyId = val.trim(); });
			});

		new Setting(s3Section)
			.setName('Secret access key')
			.setDesc(this.editMount?.mountType === 's3'
				? (this.editMount.encryptedS3SecretKey
					? 'Saved securely on this device. Leave blank to keep, or enter a new value to replace.'
					: 'Leave blank to keep the existing key. Enter a new value to replace it.')
				: 'Encrypted and saved on this device — survives Obsidian restarts.')
			.addText(text => {
				text.inputEl.type = 'password';
				text.inputEl.style.flex = '1';
				const hasStored = !!(this.editMount?.encryptedS3SecretKey);
				text.setPlaceholder(hasStored ? '(saved — leave blank to keep)' : 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')
					.setValue('')
					.onChange(val => { this.s3SecretKey = val; });
			});

		new Setting(s3Section)
			.setName('Force path-style addressing')
			.setDesc('Required for Backblaze B2, MinIO, and most self-hosted S3 servers. Leave off for Amazon S3 and Cloudflare R2.')
			.addToggle(toggle => {
				s3PathStyleToggle = toggle;
				toggle.setValue(this.s3ForcePathStyle)
					.onChange(val => { this.s3ForcePathStyle = val; });
			});

		// ── SFTP section ────────────────────────────────────────────────
		sftpSection.createEl('p', {
			text: 'Mount a remote directory over SSH/SFTP. Requires a network connection. ' +
				'The remote server must have an SFTP subsystem enabled (standard on OpenSSH). ' +
				'SFTP mounts are desktop-only.',
			cls: 'setting-item-description',
		});

		new Setting(sftpSection)
			.setName('Host')
			.setDesc('Hostname or IP address of the SFTP server')
			.addText(text => {
				text.inputEl.style.flex = '1';
				text.setPlaceholder('files.example.com')
					.setValue(this.sftpHost)
					.onChange(val => { this.sftpHost = val.trim(); });
			});

		new Setting(sftpSection)
			.setName('Port')
			.setDesc('SSH port (default 22)')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.style.width = '80px';
				text.setPlaceholder('22')
					.setValue(String(this.sftpPort))
					.onChange(val => {
						const n = parseInt(val, 10);
						this.sftpPort = isNaN(n) || n <= 0 ? 22 : n;
					});
			});

		new Setting(sftpSection)
			.setName('Username')
			.addText(text => {
				text.inputEl.style.flex = '1';
				text.setPlaceholder('alice')
					.setValue(this.sftpUsername)
					.onChange(val => { this.sftpUsername = val.trim(); });
			});

		new Setting(sftpSection)
			.setName('Remote base path')
			.setDesc('Absolute path on the remote server to use as the mount root, e.g. /home/alice/notes')
			.addText(text => {
				text.inputEl.style.flex = '1';
				text.setPlaceholder('/home/alice/notes')
					.setValue(this.mountType === 'sftp' ? (this.realPath || '/home') : '/home')
					.onChange(val => { this.realPath = val.trim() || '/'; });
			});

		new Setting(sftpSection)
			.setName('Password')
			.setDesc(this.editMount?.mountType === 'sftp'
				? (this.editMount.encryptedSftpPassword
					? 'Saved securely on this device. Leave blank to keep, or enter a new value to replace.'
					: 'Leave blank to keep the existing password.')
				: 'Used for password authentication. Leave blank if using a private key below.')
			.addText(text => {
				text.inputEl.type = 'password';
				text.inputEl.style.flex = '1';
				const hasStored = !!(this.editMount?.encryptedSftpPassword);
				text.setPlaceholder(hasStored ? '(saved — leave blank to keep)' : 'password (or leave blank for key auth)')
					.setValue('')
					.onChange(val => { this.sftpPassword = val; });
			});

		new Setting(sftpSection)
			.setName('Private key file path (optional)')
			.setDesc('Absolute path to your SSH private key file on this device, e.g. /home/alice/.ssh/id_ed25519. Leave blank for password auth.')
			.addText(text => {
				text.inputEl.style.flex = '1';
				text.setPlaceholder('/home/yourname/.ssh/id_ed25519')
					.setValue(this.sftpPrivateKeyPath)
					.onChange(val => { this.sftpPrivateKeyPath = val.trim(); });
			});

		new Setting(sftpSection)
			.setName('Private key passphrase (optional)')
			.setDesc(this.editMount?.mountType === 'sftp'
				? (this.editMount.encryptedSftpPassphrase
					? 'Saved securely on this device. Leave blank to keep.'
					: 'Leave blank to keep the existing passphrase.')
				: 'Only needed if your private key is passphrase-protected.')
			.addText(text => {
				text.inputEl.type = 'password';
				text.inputEl.style.flex = '1';
				const hasStored = !!(this.editMount?.encryptedSftpPassphrase);
				text.setPlaceholder(hasStored ? '(saved — leave blank to keep)' : 'passphrase (if key is encrypted)')
					.setValue('')
					.onChange(val => { this.sftpPassphrase = val; });
			});

		// Apply initial visibility
		toggleSections(this.mountType);

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
		const realPathSetting = new Setting(localSection)
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
			localSection.createEl('p', {
				text: 'WSL tip: To mount a Linux (WSL 2) folder in Windows Obsidian, use ' +
					'\\\\wsl.localhost\\<Distro>\\path (Windows 11 / Win 10 21H1+) ' +
					'or \\\\wsl$\\<Distro>\\path (older Windows 10). ' +
					'You can type either path in the Browse dialog address bar.',
				cls: 'setting-item-description',
			});
		} else if (wsl) {
			localSection.createEl('p', {
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
			.setDesc('When enabled, Folder Bridge will refuse any write operations to this mount')
			.addToggle(toggle => toggle
				.setValue(this.readOnly)
				.onChange(val => { this.readOnly = val; }));
		// ── Advanced (collapsible) ─────────────────────────────────────────────
		const details = contentEl.createEl('details', { cls: 'folderbridge-advanced' });
		// File-watcher settings are desktop-only; hide the entire Advanced section on mobile.
		if (isMobile) details.style.display = 'none';
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
		const isWebDAV = this.mountType === 'webdav';
		const isS3 = this.mountType === 's3';
		const isSFTP = this.mountType === 'sftp';

		// ── S3-specific validation ──────────────────────────────────────────
		if (isS3) {
			if (!this.s3Bucket) {
				new Notice('Folder Bridge: S3 bucket name is required.');
				return;
			}
			if (!this.s3Region) {
				new Notice('Folder Bridge: S3 region is required.');
				return;
			}
			if (!this.s3AccessKeyId) {
				new Notice('Folder Bridge: S3 access key ID is required.');
				return;
			}
			const hasStoredSecret = !!(this.editMount?.encryptedS3SecretKey);
			if (!this.editMount && !this.s3SecretKey && !hasStoredSecret) {
				new Notice('Folder Bridge: S3 secret access key is required.');
				return;
			}
			if (!this.virtualPath.trim()) {
				new Notice('Folder Bridge: Virtual path is required.');
				return;
			}

			const normalizedVirtual = normalizePath(this.virtualPath.trim());
			const prefix = this.s3Prefix || '/';

			await this.onSave(
				{
					virtualPath: normalizedVirtual,
					realPath: prefix,
					enabled: this.editMount ? this.editMount.enabled : true,
					readOnly: this.readOnly,
					label: this.label || undefined,
					mountType: 's3',
					s3Bucket: this.s3Bucket,
					s3Region: this.s3Region,
					s3Endpoint: this.s3Endpoint || undefined,
					s3AccessKeyId: this.s3AccessKeyId,
					s3ForcePathStyle: this.s3ForcePathStyle || undefined,
					s3SecretKey: this.s3SecretKey || undefined,
					maxFiles: this.maxFiles,
				},
				this.editMount?.id,
			);
			this.close();
			return;
		}

		// ── SFTP-specific validation ────────────────────────────────────────
		if (isSFTP) {
			if (!this.sftpHost) {
				new Notice('Folder Bridge: SFTP host is required.');
				return;
			}
			if (!this.sftpUsername) {
				new Notice('Folder Bridge: SFTP username is required.');
				return;
			}
			const hasStoredPassword = !!(this.editMount?.encryptedSftpPassword);
			const hasKeyPath = !!this.sftpPrivateKeyPath;
			if (!this.editMount && !this.sftpPassword && !hasStoredPassword && !hasKeyPath) {
				new Notice('Folder Bridge: SFTP password or private key path is required.');
				return;
			}
			if (!this.virtualPath.trim()) {
				new Notice('Folder Bridge: Virtual path is required.');
				return;
			}

			const normalizedVirtual = normalizePath(this.virtualPath.trim());
			const remotePath = this.realPath || '/';

			await this.onSave(
				{
					virtualPath: normalizedVirtual,
					realPath: remotePath,
					enabled: this.editMount ? this.editMount.enabled : true,
					readOnly: this.readOnly,
					label: this.label || undefined,
					mountType: 'sftp',
					sftpHost: this.sftpHost,
					sftpPort: this.sftpPort !== 22 ? this.sftpPort : undefined,
					sftpUsername: this.sftpUsername,
					sftpPassword: this.sftpPassword || undefined,
					sftpPrivateKeyPath: this.sftpPrivateKeyPath || undefined,
					sftpPassphrase: this.sftpPassphrase || undefined,
					maxFiles: this.maxFiles,
				},
				this.editMount?.id,
			);
			this.close();
			return;
		}

		// ── WebDAV-specific validation ─────────────────────────────────────
		if (isWebDAV) {
			if (!this.webdavUrl) {
				new Notice('Folder Bridge: WebDAV server URL is required.');
				return;
			}
			try { new URL(this.webdavUrl); } catch {
				new Notice('Folder Bridge: WebDAV URL is not valid. Include the scheme, e.g. https://…');
				return;
			}
			if (!this.webdavUsername) {
				new Notice('Folder Bridge: WebDAV username is required.');
				return;
			}
			// Require a password on add unless an encrypted one is already stored
			// (e.g. user opens settings on the same device that originally saved it)
			const hasStoredPassword = !!(this.editMount?.encryptedWebdavPassword);
			if (!this.editMount && !this.webdavPassword && !hasStoredPassword) {
				new Notice('Folder Bridge: WebDAV password is required.');
				return;
			}
			if (!this.virtualPath.trim()) {
				new Notice('Folder Bridge: Virtual path is required.');
				return;
			}

			const normalizedVirtual = normalizePath(this.virtualPath.trim());
			const remotePath = this.realPath || '/';

			await this.onSave(
				{
					virtualPath: normalizedVirtual,
					realPath: remotePath,
					enabled: this.editMount ? this.editMount.enabled : true,
					readOnly: this.readOnly,
					label: this.label || undefined,
					mountType: 'webdav',
					webdavUrl: this.webdavUrl,
					webdavUsername: this.webdavUsername,
					// Pass password transiently so plugin can store it under the real mount id
					webdavPassword: this.webdavPassword || undefined,
					watcherDebounceMs: undefined,
					watcherUsePolling: undefined,
					watcherPollingIntervalMs: undefined,
					maxFiles: this.maxFiles,
				},
				this.editMount?.id,
			);
			this.close();
			return;
		}

		// ── Local filesystem validation ────────────────────────────────────
		// Fall back to the real folder's base name when no virtual path was typed
		const virtualPathToUse = this.virtualPath.trim()
			|| (this.realPath ? path.basename(this.realPath) : '');

		if (!virtualPathToUse) {
			new Notice('Folder Bridge: Virtual path is required.');
			return;
		}
		if (!this.realPath) {
			new Notice('Folder Bridge: Real path is required.');
			return;
		}
		if (!path.isAbsolute(this.realPath)) {
			new Notice('Folder Bridge: Real path must be an absolute filesystem path.');
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
			new Notice(`Folder Bridge: ${validationError}`);
			return;
		}

		// Only re-check accessibility when the real path has changed (or this is a new mount)
		const realPathChanged = !this.editMount || this.editMount.realPath !== this.realPath;
		if (realPathChanged) {
			const dirExists = await isDirectory(this.realPath);
			if (!dirExists) {
				new Notice(`Folder Bridge: "${this.realPath}" is not an accessible directory.`);
				return;
			}

			const { accessible, error } = await checkPathAccessible(this.realPath);
			if (!accessible) {
				new Notice(`Folder Bridge: Cannot access "${this.realPath}": ${error}`);
				return;
			}
		}

		// Non-blocking advisory warnings (e.g. UNC / network paths)
		const warnings = this.security.getPathWarnings(this.realPath);
		for (const w of warnings) {
			new Notice(`Folder Bridge warning: ${w}`, 10_000);
		}

		await this.onSave(
			{
				virtualPath: normalizedVirtual,
				realPath: this.realPath,
				enabled: this.editMount ? this.editMount.enabled : true,
				readOnly: this.readOnly,
				label: this.label || undefined,
				mountType: this.mountType === 'local' ? undefined : this.mountType,
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
	// Remote mounts (WebDAV, S3, SFTP) have no local filesystem path to check.
	// Their reachability is probed by the plugin's health-check loop separately.
	// Return a placeholder "reachable" status so the settings panel stays clean.
	if (mount.mountType === 'webdav' || mount.mountType === 's3' || mount.mountType === 'sftp') {
		return {
			mount,
			reachable: true,
			readOnly: mount.readOnly,
			error: undefined,
		};
	}
	const { accessible, readOnly, error } = await checkPathAccessible(mount.realPath);
	return {
		mount,
		reachable: accessible,
		readOnly: mount.readOnly || readOnly,
		error,
	};
}
