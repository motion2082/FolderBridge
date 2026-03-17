import { App, Modal, Setting } from 'obsidian';

/**
 * First-run welcome modal shown once when Folder Bridge is loaded with no
 * mounts configured.  Gives new users a quick orientation and a direct path
 * to adding their first mount without having to hunt through Settings.
 */
export class WelcomeModal extends Modal {
	private onAddMount: () => void;
	private onDismiss: () => void;

	constructor(app: App, onAddMount: () => void, onDismiss: () => void) {
		super(app);
		this.onAddMount = onAddMount;
		this.onDismiss = onDismiss;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: 'Welcome to Folder Bridge' });

		const descEl = contentEl.createDiv({ cls: 'folderbridge-welcome-desc' });

		descEl.createEl('p', {
			text: 'Folder Bridge lets you mount external folders into your vault as seamless, native-feeling directories, with no copying, duplication, or symlinks required.',
		}).addClass('folderbridge-welcome-intro');

		descEl.createEl('p', { text: 'What you can mount' }).addClass('folderbridge-welcome-intro');

		const list = descEl.createEl('ul', { cls: 'folderbridge-feature-list' });
		for (const item of [
			'Local folders on this device (or a connected drive)',
			'WebDAV servers — Nextcloud, ownCloud, NAS, Synology',
			'Folders from another Obsidian vault on this device',
		]) {
			list.createEl('li', { text: item, cls: 'folderbridge-feature-item' });
		}

		descEl.createEl('p', {
			text: 'Mounted folders appear instantly in the file explorer, support full-text search, Quick Switcher, and all your plugins.',
			cls: 'setting-item-description',
		});

		const tipBox = contentEl.createDiv({ cls: 'folderbridge-tip-box' });
		tipBox.createEl('strong', { text: '💡 quick tip: ' });
		tipBox.appendText('After adding a mount, you can manage it from ');
		tipBox.createEl('strong', { text: 'Settings, then Folder Bridge' });
		tipBox.appendText('. Per-mount options: read-only, custom ignore list, watcher tuning, and device-specific path overrides.');

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Add my first mount')
				.setCta()
				.onClick(() => {
					this.close();
					this.onAddMount();
				}))
			.addButton(btn => btn
				.setButtonText('I\'ll explore on my own')
				.onClick(() => {
					this.close();
					this.onDismiss();
				}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
