# Changelog

All notable changes to Folder Bridge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-02-22

### Fixed
- Fixed a critical bug where creating or modifying files in mounted folders would fail because Obsidian's internal file existence checks were receiving generic errors instead of the expected `ENOENT` error code.
- Fixed an issue where images and other resources in mounted folders might fail to load due to incorrect path resolution.

## [0.3.0] - 2026-02-21

### Added
- **WSL Support**: Added a dedicated "Browse WSL…" button for Windows users to easily mount Linux folders directly from their WSL distributions.

## [0.2.0] - 2026-02-21

### Added
- **Sync Compatibility (Obsidian Sync / Syncthing)**: Mounts are now tagged with a unique `deviceId` to prevent devices from attempting to mount paths that don't exist locally.
- **Foreign Mounts Toggle**: Added a setting to allow mounting paths created on other devices if the paths are identical across devices.
- **Device-Specific Path Overrides**: Added the ability to map a foreign mount to a different local path using the native OS folder browser.
- **Ignore List**: Added a setting to specify files or folders (using exact names or glob patterns like `*.tmp`) that should be hidden from Obsidian and ignored by the virtual adapter.
- **Context Menu Integration**: Added an "Ignore in Folder Bridge" option to the file explorer context menu for files and folders inside mounted directories.

### Fixed
- **Performance Optimization**: Fixed a severe "Loading Cache" freeze on startup by scoping the ignore list checks strictly to virtual mount paths, preventing the plugin from scanning the entire native vault.

## [0.1.0] - 2026-02-21

### Added
- Virtual mount point system: map any absolute filesystem path into the vault at any virtual path
- `VirtualAdapter` shim wrapping Obsidian's built-in `FileSystemAdapter` via a JavaScript `Proxy`
- `PathMapper` for bidirectional translation between virtual vault paths and real filesystem paths
- `SecurityManager` with explicit allowlist enforcement; system directories blocked by default
- Full Windows support:
  - Long path prefix (`\\?\`) for paths exceeding 260 characters
  - UNC network path detection and advisory warnings
  - Windows reserved filename blocking (`CON`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`)
  - Case-insensitive NTFS path comparisons
  - Cross-device move fallback (`EXDEV` → copy-then-delete)
- **Native folder browser** — "Browse…" button opens the OS folder picker (Electron `remote.dialog`); falls back gracefully to manual entry if unavailable
- **Vault folder picker** — "Browse vault…" button opens a fuzzy-search modal of existing vault folders for easy virtual-path nesting
- **Auto-label from folder name** — "Use folder name as label" toggle auto-fills the display label with the real folder's base name; editable at any time
- **WSL cross-environment hints** — contextual tips in the add-mount dialog:
  - On Windows: `\\wsl.localhost\<Distro>\path` UNC pattern for accessing WSL 2 Linux folders
  - In WSL: `/mnt/c/` etc. and how to expose the same folder to Windows-side Obsidian
- `isWSL()` and `wslMountToWindowsPath()` helpers in `OSHelpers.ts`
- Read-only mount flag to prevent accidental writes
- Mount enable/disable toggle (no removal required)
- Optional display labels for mounts
- Dry-run mode: logs all writes to console without executing them
- Status bar item showing count of active mounts
- `MountManagerModal` UI for adding and validating mount points
- Async mount status badges in settings (reachable / read-only / error)
- `versions.json` for Obsidian's automatic update mechanism
- Vitest unit test suite (72 tests covering PathMapper, SecurityManager, OSHelpers)
- GitHub Actions: build check workflow and release workflow using `softprops/action-gh-release`

### Fixed
- Virtual mounts now appear in the file explorer immediately on load and when added/toggled/removed — `notifyVaultMountAdded/Removed` fires `vault.onChange('created'/'deleted')` so Obsidian inserts the `TFolder` into its tree without a restart
- Status bar text was not populated when enabling the status bar item via the settings toggle
- `stat()` now returns a synthetic folder stat for virtual intermediate directories (e.g. `Projects` when the mount is `Projects/Work`), preventing Obsidian from treating them as non-existent
- `getVirtualMountsDirectChildren` now correctly surfaces intermediate virtual directories in vault listings so nested mount paths (e.g. `Projects/Work`) are visible when browsing the vault root
- Binary file copying from vault to a mounted folder now uses `readBinary()` instead of `read()`, preventing UTF-8 corruption of images, PDFs, and other non-text files

[0.1.0]: https://github.com/tescolopio/Obsidian_FolderBridge/releases/tag/0.1.0
