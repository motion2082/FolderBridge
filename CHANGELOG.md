# Changelog

All notable changes to Folder Bridge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-02-23

### Added
- **Conflict resolution UI**: FolderBridge now performs a background reachability check every 30 seconds on all active mounts. When a mount goes unreachable (drive disconnected, network share dropped, cloud placeholder), a warning Notice fires immediately and the status bar turns orange showing the count of unreachable mounts.
- **Reconnect button**: Each unreachable mount row in Settings shows a ⚠️ Reconnect button. Clicking it re-checks the path, re-injects the vault tree, and restarts the file watcher — no plugin reload required.
- **Automatic back-online notice**: When a previously-unreachable mount becomes accessible again (drive reconnected, network restored), a confirmation Notice fires automatically on the next health-check cycle.
- **Status bar health indicator**: The status bar item now turns orange and shows the count of unreachable mounts when any mount is down. Returns to normal colour when all are reachable.

## [0.5.0] - 2026-02-23

### Added
- **Edit mount in-place**: "Edit" button on each mount row opens the Add Mount modal pre-populated with the current values. Virtual path, real path, label, and read-only flag can all be changed without removing and re-adding the mount. The vault tree and file watcher are updated live on save.
- **Drag-drop reordering**: Mount rows in the Settings panel are now draggable. Drag any row to a new position to reorder mounts. The order is persisted immediately.
- **"Move mount to…" context menu**: Right-clicking a mount's root folder in the file explorer shows a "Move mount to…" item. Selecting it opens the vault folder picker and relocates the mount's virtual path — live, no restart needed.
- **"Browse…" button in ignore list**: A "Browse…" button next to the ignore-list text input opens the OS folder picker rooted at the selected mount's real path. Picking a folder fills the input with the path relative to the mount root (e.g., `assets/vendor/plantuml-stdlib`).
- **Path-relative ignore patterns**: Ignore list entries that contain a `/` (e.g., `assets/vendor`) are now matched as path-prefix patterns against the item's location within the mount, not just the leaf name. This lets you ignore a deeply nested folder without ignoring every folder with the same name across the whole mount.

### Fixed
- **Ignore list now refreshes the file explorer immediately**: Adding a new ignore pattern now removes matching files and folders from the file explorer straight away — no restart or manual refresh needed. The ignore cache is also rebuilt so the watcher and directory listing honour the new pattern at once.

## [0.4.4] - 2026-02-23

### Documentation
- **Platform support table** — Added explicit Windows / macOS / Linux / mobile status to the README Features section so platform expectations are clear upfront.
- **macOS** — Marked as untested (POSIX code paths implemented; community reports welcome). Added iCloud optimized-storage workaround note.
- **Mobile** — Clearly documented that iOS and Android are unsupported due to the OS sandbox; this is a hard platform restriction, not a missing feature.
- **Platform Notes section** — Renamed "Windows Notes" to "Platform Notes" and added dedicated macOS and Mobile subsections.

## [0.4.3] - 2026-02-22

### Fixed
- **Image and PDF loading** — Modern Obsidian uses `app://<vaultId>/` which only resolves vault-relative paths; `app://local/` is deprecated and returns `ERR_FILE_NOT_FOUND` for external mounts. Images, PDFs, and other embedded assets are now served as `data:` URIs (base64-encoded, capped at 10 MB) so they render correctly regardless of vault location.
- **Rename race on new notes** — When creating a note in a mounted folder and immediately typing a title, Obsidian could call `rename()` before `write()` had finished writing the file to disk (or while OneDrive's sync engine was reprocessing the new file). `rename()` now polls for the source file for up to 2 seconds before giving up, and succeeds silently if the destination already exists (idempotent rename).
- **Debounce rapid file-change events** — Back-to-back saves from external tools (PlantUML, DataviewJS, watch-mode compilers) previously fired multiple `file-changed` vault notifications. A 300 ms per-path trailing-edge debounce now coalesces these into a single notification.
- **Cloud placeholder ENOENT** — OneDrive "Files On Demand" online-only files appear accessible but throw `ENOENT` on read. The adapter now detects this fingerprint and surfaces a clear error message with "Always keep on this device" guidance.

### Performance
- **PathMapper lookup** — `getMountForPath()` was sorting and re-normalizing the mounts array on every call (O(N log N) + alloc per I/O op). Mounts are now sorted and pre-normalized once in `update()` and cached; the hot-path lookup iterates that frozen array with zero allocations.

## [0.4.2] - 2026-02-22

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
