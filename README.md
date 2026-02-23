# Folder Bridge

Extends Obsidian's single-root vault by letting you mount external folders as seamless, native-feeling directories inside your vault. Files stay in their original locations — no copying, no duplicating, no symlinking required.

---

## Features

- **Virtual Mount Points** — Map any absolute filesystem path into your vault at any virtual path
- **Multi-Root Workspaces** — Work with files from multiple locations simultaneously
- **Seamless Integration** — External folders appear and behave as native vault directories in the File Explorer, Quick Switcher, and all Obsidian commands
- **Zero Duplication** — Files are read and written directly from their real locations
- **Sync Compatibility** — Safely sync your vault across devices (Obsidian Sync, Syncthing). Mounts are device-specific, and you can map foreign mounts to different local paths on each device.
- **Ignore List** — Hide specific files or folders (e.g., `node_modules`, `*.tmp`) from Obsidian to improve performance and reduce clutter.
- **Read-Only Mounts** — Protect external folders from accidental writes
- **Windows Hardened** — Full support for long paths (>260 chars), UNC network paths, Windows reserved filenames, case-insensitive NTFS comparisons, and cross-device moves
- **Security Allowlist** — Only explicitly approved real paths can be accessed; system directories are blocked
- **Dry-Run Mode** — Log all write operations to the console without executing them (safe for testing)

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
2. **Real path** — click **Browse…** to open the system folder picker, or type the absolute path directly
   - Windows example: `C:\Users\YourName\Documents\Work`
   - Linux / macOS example: `/home/yourname/Documents/Work`
   - WSL folder from Windows: `\\wsl.localhost\Ubuntu\home\yourname\Work`
3. **Virtual path** — where the folder will appear inside your vault, e.g. `Projects/Work`
   - Click **Browse vault…** to pick an existing vault folder as the parent
   - Leave empty to mount at vault root using the real folder's name
4. Optionally enable **Use folder name as label** to auto-fill the display name, or type a custom label
5. Click **Validate & Add**

The folder appears immediately in Obsidian's file explorer — no restart needed. Files are read
and written directly from their original location; nothing is copied or moved.

---

## Settings

| Setting | Description |
|---------|-------------|
| **Dry-run mode** | Log all writes to console without executing them. Safe for testing. |
| **Show status bar item** | Display active mount count in Obsidian's status bar. |
| **Mount list** | Enable, disable, or remove individual mounts. Each mount shows a live reachability badge. |
| **Allow foreign mounts** | Allow mounts created on other devices to be active if the path exists locally. |
| **Ignore list** | Hide specific files or folders (e.g., `node_modules`, `*.tmp`) from Obsidian. |

---

## Sync Compatibility (Obsidian Sync / Syncthing)

FolderBridge is designed to work safely with sync engines. When you create a mount, it is tagged with a unique `deviceId` for your current Obsidian instance. This prevents other devices from attempting to mount paths that don't exist locally.

If you sync your vault to another device:
- **Identical Paths**: If the external folder exists at the exact same path on both devices, you can enable **Allow foreign mounts** in the settings to automatically activate it.
- **Different Paths**: If the external folder is located elsewhere on the second device, you can click the **Override Path** button next to the mount in the settings to map it to the correct local path for that specific device.

---

## Ignore List

You can hide specific files or folders from Obsidian to improve performance and reduce clutter. This is especially useful for large directories like `node_modules` or build outputs.

- **Exact Match**: Enter the exact name of the file or folder (e.g., `node_modules`).
- **Glob Patterns**: Use `*` as a wildcard (e.g., `*.tmp`, `build*`).
- **Context Menu**: Right-click any file or folder inside a mounted directory in Obsidian's file explorer and select **Ignore in Folder Bridge** to quickly add it to the list.

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
