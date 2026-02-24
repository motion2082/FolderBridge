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

        contentEl.createEl('h2', { text: '👋 Welcome to Folder Bridge' });

        const descEl = contentEl.createDiv();
        descEl.style.marginBottom = '16px';

        descEl.createEl('p', {
            text: 'Folder Bridge extends Obsidian\'s single-root vault by letting you mount external folders as seamless, native-feeling directories — no copying, no duplicating, no symlinks required.',
        }).style.marginBottom = '8px';

        descEl.createEl('p', { text: 'What you can mount:' }).style.marginBottom = '4px';

        const list = descEl.createEl('ul');
        list.style.marginLeft = '16px';
        list.style.marginBottom = '12px';
        for (const item of [
            '📁  Local folders on this device (or a connected drive)',
            '🌐  WebDAV servers — Nextcloud, ownCloud, NAS, Synology',
            '🔗  Folders from another Obsidian vault on this device',
        ]) {
            list.createEl('li', { text: item }).style.marginBottom = '4px';
        }

        descEl.createEl('p', {
            text: 'Mounted folders appear instantly in the file explorer, support full-text search, Quick Switcher, and all your plugins.',
            cls: 'setting-item-description',
        });

        const tipBox = contentEl.createDiv();
        tipBox.style.padding = '10px 14px';
        tipBox.style.backgroundColor = 'var(--background-modifier-message)';
        tipBox.style.border = '1px solid var(--background-modifier-border)';
        tipBox.style.borderRadius = '6px';
        tipBox.style.marginBottom = '20px';
        tipBox.createEl('strong', { text: '💡 Quick tip: ' });
        tipBox.appendText('After adding a mount, you can manage it from ');
        tipBox.createEl('strong', { text: 'Settings → Folder Bridge' });
        tipBox.appendText('. Per-mount options: read-only, custom ignore list, watcher tuning, and device-specific path overrides.');

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Add my first mount →')
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
