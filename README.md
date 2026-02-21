# Obsidian FolderBridge

Extends Obsidian's single-root vault by letting you mount external folders as seamless, native-feeling directories inside your vault. Files stay in their original locations — no copying, no duplicating, no symlinking required.

---

## Features

- **Virtual Mount Points** — Map any absolute filesystem path into your vault at any virtual path
- **Multi-Root Workspaces** — Work with files from multiple locations simultaneously
- **Seamless Integration** — External folders appear and behave as native vault directories in the File Explorer, Quick Switcher, and all Obsidian commands
- **Zero Duplication** — Files are read and written directly from their real locations
- **Read-Only Mounts** — Protect external folders from accidental writes
- **Windows Hardened** — Full support for long paths (>260 chars), UNC network paths, Windows reserved filenames, case-insensitive NTFS comparisons, and cross-device moves
- **Security Allowlist** — Only explicitly approved real paths can be accessed; system directories are blocked
- **Dry-Run Mode** — Log all write operations to the console without executing them (safe for testing)

---

## Installation

### From Obsidian Community Plugins (recommended)

1. Open **Settings → Community Plugins** and disable Safe Mode if needed
2. Click **Browse** and search for **FolderBridge**
3. Install and enable the plugin

### Manual Installation

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/tescolopio/Obsidian_FolderBridge/releases/latest)
2. Copy them to `<your-vault>/.obsidian/plugins/obsidian-folderbridge/`
3. Enable the plugin in **Settings → Community Plugins**

### Local Development (git clone)

If you want to run straight from source (no release download needed):

```bash
# 1. Clone into your vault's plugin folder
git clone https://github.com/tescolopio/Obsidian_FolderBridge.git \
  /path/to/your-vault/.obsidian/plugins/obsidian-folderbridge

cd /path/to/your-vault/.obsidian/plugins/obsidian-folderbridge

# 2. Install dependencies
npm install

# 3. Build the plugin (produces main.js that Obsidian loads)
npm run build
```

Then in Obsidian: **Settings → Community Plugins → disable Safe Mode → enable FolderBridge**.

> **Hot-reload during development:** run `npm run dev` instead of `npm run build`.
> Install the [hot-reload plugin](https://github.com/pjeby/hot-reload) in Obsidian and it will
> automatically reload FolderBridge whenever `main.js` is rebuilt.

---

## Quick Start

1. Click the **folder-plus** ribbon icon (or go to **Settings → FolderBridge**)
2. Click **Add Mount Point**
3. Fill in:
   - **Virtual path** — where the folder will appear in your vault, e.g. `Projects/Work`
   - **Real path** — the absolute path on disk, e.g. `C:\Users\YourName\Documents\Work` (Windows) or `/home/yourname/Documents/Work` (Linux/Mac)
4. Click **Validate & Add**

The folder appears immediately in Obsidian's file explorer at the virtual path you chose —
no restart needed. Files are read and written directly from their original location on disk;
nothing is copied or moved.

---

## Settings

| Setting | Description |
|---------|-------------|
| **Dry-run mode** | Log all writes to console without executing them. Safe for testing. |
| **Show status bar item** | Display active mount count in Obsidian's status bar. |
| **Mount list** | Enable, disable, or remove individual mounts. Each mount shows a live reachability badge. |

---

## Windows Notes

- **Long paths**: Paths over 260 characters are handled automatically with the `\\?\` prefix. For best results, also enable **Long Path Support** in Windows Settings → System → For Developers.
- **Symlinks**: Creating symlinks on Windows requires either Developer Mode or administrator rights. FolderBridge itself does not create symlinks, but the underlying filesystem may encounter related permission errors.
- **UNC network paths** (`\\server\share\...`): Supported, but file-change watching may not work on some servers and the path may be unavailable offline.
- **Reserved names**: Files and folders named `CON`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9` (Windows reserved device names) are blocked from creation via FolderBridge to prevent cryptic OS errors.

---

## Architecture

FolderBridge installs a lightweight **virtual filesystem adapter shim** that intercepts every I/O call Obsidian makes to its vault:

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
New-Item -ItemType Junction -Path "$env:APPDATA\obsidian\<YourVault>\.obsidian\plugins\obsidian-folderbridge" -Target (Get-Location)

# Linux / macOS
ln -s "$(pwd)" "/path/to/vault/.obsidian/plugins/obsidian-folderbridge"
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
