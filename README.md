# Folder Bridge

Extends Obsidian's single-root vault by letting you mount external folders as seamless, native-feeling directories inside your vault. Files stay in their original locations — no copying, no duplicating, no symlinking required.

---

## Features

- **Virtual Mount Points** — Map any absolute filesystem path into your vault at any virtual path
- **Multi-Root Workspaces** — Work with files from multiple locations simultaneously
- **Seamless Integration** — External folders appear and behave as native vault directories in the File Explorer, Quick Switcher, and all Obsidian commands
- **Zero Duplication** — Files are read and written directly from their real locations
- **WebDAV Support** — Mount Nextcloud, ownCloud, or any generic WebDAV server as a virtual vault folder. Credentials are stored in session memory only, never synced.
- **Vault-to-Vault Bridging** — Mount a folder from another Obsidian vault on the same device. `.obsidian` config and `.trash` are automatically excluded.
- **Sync Compatibility** — Safely sync your vault across devices (Obsidian Sync, Syncthing). Mounts are device-specific, and you can map foreign mounts to different local paths on each device.
- **Ignore List** — Hide specific files or folders (e.g., `node_modules`, `*.tmp`) from Obsidian to improve performance and reduce clutter.
- **Read-Only Mounts** — Protect external folders from accidental writes
- **Windows Hardened** — Full support for long paths (>260 chars), UNC network paths, Windows reserved filenames, case-insensitive NTFS comparisons, and cross-device moves
- **Security Allowlist** — Only explicitly approved real paths can be accessed; system directories are blocked
- **Dry-Run Mode** — Log all write operations to the console without executing them (safe for testing)
- **Conflict Resolution UI** — Background reachability checks every 30 s; orange status bar and per-mount reconnect button when a mount goes offline
- **Per-Mount Performance Tuning** — Configure debounce threshold, polling mode, polling interval, and max-files scan limit per mount

### Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| Windows | ✅ Tested | Full support — long paths, UNC, NTFS quirks all handled |
| macOS | ⚠️ Untested | POSIX code paths are implemented; not yet officially tested. Community reports welcome. |
| Linux | ✅ Tested | POSIX paths, works including WSL |
| iOS / Android | ❌ Not supported | Obsidian's mobile sandbox prevents access to arbitrary filesystem paths |

---

## Installation

### From Obsidian Community Plugins (recommended)

1. Open **Settings → Community Plugins** and disable Safe Mode if needed
2. Click **Browse** and search for **Folder Bridge**
3. Install and enable the plugin

### Using BRAT (Beta Reviewers Auto-update Tool)

If you want to test the latest pre-release versions or if the plugin is not yet available in the community directory, you can install it using [BRAT](https://tfthacker.com/BRAT):

1. Install the **Obsidian42 - BRAT** plugin from the Community Plugins directory.
2. Enable BRAT in your settings.
3. Open the command palette and run **BRAT: Add a beta plugin for testing**.
4. Enter the repository URL: `https://github.com/tescolopio/Obsidian_FolderBridge`
5. Click **Add Plugin**. BRAT will automatically download and install the latest release.

### Manual Installation

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/tescolopio/Obsidian_FolderBridge/releases/latest)
2. Copy them to `<your-vault>/.obsidian/plugins/folderbridge/`
3. Enable the plugin in **Settings → Community Plugins**

### Local Development (git clone)

If you want to run straight from source (no release download needed):

```bash
# 1. Clone into your vault's plugin folder
git clone https://github.com/tescolopio/Obsidian_FolderBridge.git \
  /path/to/your-vault/.obsidian/plugins/folderbridge

cd /path/to/your-vault/.obsidian/plugins/folderbridge

# 2. Install dependencies
npm install

# 3. Build the plugin (produces main.js that Obsidian loads)
npm run build
```

Then in Obsidian: **Settings → Community Plugins → disable Safe Mode → enable Folder Bridge**.

> **Hot-reload during development:** run `npm run dev` instead of `npm run build`.
> Install the [hot-reload plugin](https://github.com/pjeby/hot-reload) in Obsidian and it will
> automatically reload Folder Bridge whenever `main.js` is rebuilt.

---

## Quick Start

1. Click the **folder-plus** ribbon icon (or go to **Settings → Folder Bridge → Add Mount Point**)
2. Select the **Mount Type** (Local folder, WebDAV server, or Another Obsidian vault)
3. Fill in the **Real path** and **Virtual path**, then click **Validate & Add**

The folder appears immediately in Obsidian's file explorer — no restart needed.

For full step-by-step instructions on each mount type and feature, see the [Usage Guide](#usage-guide) below.

---

## Usage Guide

### Adding a Local Mount

1. Click the **folder-plus** ribbon icon, or go to **Settings → Folder Bridge** and click **Add Mount Point**
2. In the **Mount Type** dropdown, select **Local folder**
3. **Real path** — click **Browse…** to open the OS folder picker, or type the absolute path  
   - Windows: `C:\Users\YourName\Documents\Work`  
   - Linux / macOS: `/home/yourname/Documents/Work`  
   - WSL path from Windows: `\\wsl.localhost\Ubuntu\home\yourname\Work`  
   - UNC network path: `\\server\share\documents`
4. **Virtual path** — where the folder will appear inside your vault, e.g. `Projects/Work`  
   - Click **Browse vault…** to pick an existing vault folder as the parent  
   - Leave empty to mount at vault root using the real folder's name
5. Optionally set a **Label** for the mount (shown in the settings list)
6. Optionally enable **Read-only** to block all writes through this mount
7. Click **Validate & Add**

The folder appears immediately in Obsidian's file explorer. No restart needed.

---

### Adding a WebDAV Mount

Mount a remote Nextcloud, ownCloud, or generic WebDAV server as a vault folder.

1. Click **Add Mount Point** and select **WebDAV server** in the **Mount Type** dropdown
2. **Server URL** — the full URL to your WebDAV server, e.g.:
   - Nextcloud: `https://cloud.example.com/remote.php/dav/files/username`
   - Generic: `https://dav.example.com`
3. **Remote path** — the path on the server to mount, e.g. `/Documents/Notes`
4. **Virtual path** — where it will appear in your vault, e.g. `Remote/Notes`
5. **Username** — your WebDAV username
6. **Password** — your WebDAV password  
   > ⚠️ The password is stored in **session memory only**. It is never written to `data.json` or synced to other devices. You will be prompted again when Obsidian restarts.
7. Click **Validate & Add**

Folder Bridge will test the connection before saving. If the server is unreachable, you'll see an error with the reason.

---

### Vault-to-Vault Bridging

Browse a folder from a second Obsidian vault inside your current one without duplicating files.

1. Click **Add Mount Point** and select **Another Obsidian vault** in the **Mount Type** dropdown
2. **Real path** — click **Browse…** and navigate to the **root folder** of the other vault (the folder that contains the `.obsidian` directory)
3. Optionally narrow to a **sub-folder** of that vault by specifying a relative path inside it
4. Set a **Virtual path** where it will appear in your current vault, e.g. `Reference`
5. Click **Validate & Add**

Folder Bridge automatically adds `.obsidian`, `.trash`, and `.smart-connections` to the ignore list for vault mounts to prevent the two vaults from interfering with each other.

---

### Editing an Existing Mount

All mount settings can be changed without deleting and re-adding the mount.

1. Open **Settings → Folder Bridge**
2. Click the **Edit** (pencil) button on any mount row
3. Change any field — virtual path, real path, label, read-only flag, or watcher settings
4. Click **Save**

The vault tree, file watcher, and all internal caches update live. No restart needed.

---

### Reordering Mounts

The order of mounts in the list determines the order they are checked during path resolution.

- **Drag** a mount row up or down in **Settings → Folder Bridge** to reorder it
- The new order is saved immediately

---

### Moving a Mount in the File Explorer

You can change a mount's virtual path directly from Obsidian's file explorer without opening Settings.

**Option 1 — Drag and drop:**
1. In the file explorer, click and hold the mounted folder
2. Drag it to a new location in the vault hierarchy
3. The virtual path updates live — nothing on disk is touched

**Option 2 — Context menu:**
1. Right-click the mounted folder root in the file explorer
2. Select **Move mount to…**
3. Choose a new parent folder from the vault picker
4. Click **Move**

---

### Read-Only Mounts

Prevent any write operations through a specific mount (useful for reference folders or shared network drives you don't own).

- Enable the **Read-only** toggle when adding or editing a mount
- Obsidian will still be able to open, search, and read all files in the mount
- Any attempt to create, edit, rename, or delete a file through the mount will be blocked with a clear error

---

### Ignore List

Hide specific files or folders inside a mount from Obsidian. Useful for large directories (`node_modules`, build outputs) that would slow down indexing.

**Adding entries manually:**
1. Open **Settings → Folder Bridge**, expand the mount, and go to the **Ignore List** section
2. Type a pattern and click **Add**

**Adding entries with the folder picker (Browse…):**
1. Click the **Browse…** button next to the ignore list input
2. The OS folder picker opens inside the mount's real directory
3. Navigate to the subfolder you want to ignore and click **OK**
4. The mount-relative path is filled in automatically — review it and click **Add**

**Adding entries from the file explorer:**
1. Right-click any file or folder inside a mounted directory
2. Select **Ignore in Folder Bridge**
3. The entry is added immediately and the item disappears from the file explorer

**Pattern types:**

| Pattern | Behaviour | Example |
|---------|-----------|---------|
| Plain name | Matches any file or folder with that leaf name anywhere in the mount | `node_modules` |
| Path prefix (contains `/`) | Matches only that exact subtree | `assets/vendor/plantuml-stdlib` |
| Glob (contains `*`) | Matches leaf names against the glob | `*.tmp`, `~$*`, `build*` |

---

### Conflict Resolution & Health Monitoring

Folder Bridge checks every active mount for reachability every **30 seconds** in the background.

**When a mount goes offline** (drive disconnected, network drop, WebDAV server unreachable):
- An **orange indicator** appears in the Obsidian status bar
- Click the indicator to open the **Conflict Resolution panel**
- The panel shows every affected mount with its last-known error
- Click **Reconnect** next to a mount to retry it immediately

**When all mounts are reachable:**
- The status bar indicator turns **green** (if visible) or disappears, depending on your settings

---

### Per-Mount Watcher Tuning

Each mount has independent file-watcher settings. Open **Edit** on any mount to see:

| Setting | Default | Description |
|---------|---------|-------------|
| **Debounce (ms)** | 300 | How long to wait after the last file-change event before notifying Obsidian. Lower = more responsive; higher = less CPU on rapid saves. |
| **Use polling** | Off | Enable stat-based polling instead of native OS watch events. Required for most network drives and some containerised filesystems. |
| **Polling interval (ms)** | 2000 | How frequently to poll when polling mode is on. Has no effect when polling is off. |
| **Max files** | 10 000 | Stop scanning a directory tree after this many entries. Protects performance on very large mounts. |

> **Tip:** For a local SSD, leave all defaults. For a Samba/NFS network share, enable **Use polling** and set the interval to 3000–5000 ms to avoid hammering the server.

---

### Device-Specific Paths (Multi-Device Sync)

Each mount is tagged with the `deviceId` of the machine that created it. When your vault syncs to another device, that device's Obsidian will see the mount but won't activate it unless the path also exists there.

**To map a mount to a different path on another device:**

1. On the second device, open **Settings → Folder Bridge**
2. Find the mount (it will show a warning badge if the original path doesn't exist locally)
3. Click **Override Path** and enter the correct local path for this device
4. Click **Save**

The override applies only to this device; the original path is preserved for the device that created it.

**To let all mounts from other devices activate automatically (if paths match):**
- Enable **Allow foreign mounts** in **Settings → Folder Bridge**

---

## Settings Reference

| Setting | Description |
|---------|-------------|
| **Dry-run mode** | Log all write operations to the console without executing them. Safe for testing configuration changes. |
| **Show status bar item** | Display the active mount count (and health indicator) in Obsidian's status bar. |
| **Allow foreign mounts** | Activate mounts created on other devices if the real path exists on this machine. |
| **Mount list** | Enable, disable, edit, or remove individual mounts. Each row shows a live reachability badge and drag handle. |

---

## Sync Compatibility (Obsidian Sync / Syncthing)

Folder Bridge is designed to work safely with sync engines. Mounts are device-scoped and do not sync real filesystem paths to other machines. See [Device-Specific Paths](#device-specific-paths-multi-device-sync) above for cross-device setup.

---

## Ignore List (Legacy Section)

See [Ignore List](#ignore-list) in the Usage Guide above for full documentation.

---

## Platform Notes

### Windows

- **Long paths**: Paths over 260 characters are handled automatically with the `\\?\` prefix. For best results, also enable **Long Path Support** in Windows Settings → System → For Developers.
- **Symlinks**: Creating symlinks on Windows requires either Developer Mode or administrator rights. Folder Bridge itself does not create symlinks, but the underlying filesystem may encounter related permission errors.
- **UNC network paths** (`\\server\share\...`): Supported, but file-change watching may not work on some servers and the path may be unavailable offline.
- **Reserved names**: Files and folders named `CON`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9` (Windows reserved device names) are blocked from creation via Folder Bridge to prevent cryptic OS errors.
- **OneDrive Files On Demand**: Online-only placeholder files will show a user-friendly error rather than a raw ENOENT. Right-click the file in Explorer and choose **Always keep on this device** to make it locally accessible.

### macOS

> ⚠️ **macOS has not yet been officially tested.** The POSIX code paths are fully implemented and should work, but there may be edge cases. If you run into issues, please [open an issue](https://github.com/tescolopio/Obsidian_FolderBridge/issues) — macOS bug reports are actively welcomed.

- Standard absolute paths work: `/Users/yourname/Documents/Work`
- **iCloud Drive (optimized storage)**: Files set to "online only" behave like OneDrive placeholders — Folder Bridge will surface a friendly error. Open Finder, right-click the file, and choose **Download Now** to make it available locally.

### Mobile (iOS / Android)

Folder Bridge is **not supported on mobile**. Obsidian's iOS and Android sandbox prevents plugins from accessing filesystem paths outside the vault container. There is no workaround at the OS level — this is an intentional platform security restriction.

---

## Architecture

Folder Bridge installs a lightweight **virtual filesystem adapter shim** that intercepts every I/O call Obsidian makes to its vault:

```
Obsidian → vault.adapter (Proxy) → VirtualAdapter
                                        ├── path inside a mount? → Node.js fs APIs (real path)
                                        └── path outside mounts? → original FileSystemAdapter
```

A JavaScript `Proxy` forwards all undocumented Obsidian-internal methods transparently to the original adapter, so no Obsidian functionality is broken.

---

## Development Setup

### Prerequisites

- Node.js 20.x (LTS)
- npm

### Installation

```bash
git clone https://github.com/tescolopio/Obsidian_FolderBridge.git
cd Obsidian_FolderBridge
npm install
```

### Linking to your vault

```bash
# Windows (PowerShell, run as administrator or with Developer Mode enabled)
New-Item -ItemType Junction -Path "$env:APPDATA\obsidian\<YourVault>\.obsidian\plugins\folderbridge" -Target (Get-Location)

# Linux / macOS
ln -s "$(pwd)" "/path/to/vault/.obsidian/plugins/folderbridge"
```

### Build scripts

```bash
npm run dev      # Watch mode with hot-reload
npm run build    # Production build (type-checks first)
npm test         # Run unit tests
npm run version  # Bump version in manifest.json and versions.json
```

### Project structure

```
├── main.ts                    # Plugin entry point and settings UI
├── src/
│   ├── types.ts               # Shared TypeScript interfaces
│   ├── PathMapper.ts          # Virtual ↔ real path translation
│   ├── VirtualAdapter.ts      # Virtual filesystem adapter (core)
│   ├── SecurityManager.ts     # Allowlist enforcement and validation
│   ├── OSHelpers.ts           # Platform detection and Windows helpers
│   └── ui/
│       └── MountManagerModal.ts  # Add-mount dialog
├── tests/                     # Vitest unit tests
├── manifest.json              # Plugin metadata
├── versions.json              # Version → minAppVersion map
└── esbuild.config.mjs         # Build configuration
```

---

## Contributing

Contributions are welcome! Please open an issue or pull request.

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

MIT — see [LICENSE](LICENSE) for details.

## Attribution

This plugin does not use code from other Obsidian plugins. It relies solely on the official Obsidian API and standard Node.js libraries.
