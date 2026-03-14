# Roadmap for Folder Bridge

This document tracks the current status of platform support and planned features. It is updated with each release.

**Current version: v2.14.0** — Last updated: 2026-03-14

---

## Platform Status

| Platform | Status | Notes |
|----------|--------|-------|
| Windows | ✅ Stable | Full support — long paths, UNC, NTFS quirks, OneDrive Files On Demand |
| Linux | ✅ Stable | POSIX paths, WSL cross-environment support |
| macOS | ⚠️ Untested | POSIX code paths are fully implemented; no known blockers. Community testing welcomed — [open an issue](https://github.com/tescolopio/Obsidian_FolderBridge/issues) if you hit anything. |
| Android | ✅ Stable | WebDAV and S3/B2 mounts work fully on Obsidian Android. The UI automatically shows only mobile-compatible mount types. Local and SFTP mounts require the desktop Electron runtime and are hidden on mobile. |
| iOS | ❌ Not feasible | Obsidian's iOS sandbox prevents access to arbitrary filesystem paths and blocks the Node.js networking stack. Not blocked on engineering — blocked by the OS. |

---

## Recently Completed

| Version | What shipped |
|---------|-------------|
| v2.14.0 | **Reviewer-focused UI copy enforcement** — added a local UI copy checker, optional pre-commit hook, and sentence-case / branding cleanup across notices, commands, onboarding, and mount-management UI so community-plugin review issues are caught before commit. |
| v2.13.0 | **Community-plugin reviewer cleanup in TOC parsing** — removed a non-narrowing type assertion in the TOC parser and replaced it with a direct runtime object guard, keeping behavior the same while resolving the reviewer warning in `src/TocConfig.ts`. |
| v2.12.0 | **Mounted delete sync fix** — deletes initiated through mounted paths now trigger immediate vault removal notifications, so Obsidian no longer keeps stale explorer entries or tries to re-read notes that were already deleted on disk. |
| v2.11.0 | **Managed TOC workflow for UI mounts** — local and vault mounts created in Settings can now be stored in one writable JSON TOC file while additional external TOC files remain read-only and authoritative. **Guided setup** — the Settings tab now suggests a default managed TOC path and can create/bind/migrate existing UI mounts in one step. |
| v2.10.0 | **Community-plugin reviewer compatibility follow-up** — optional bundled desktop modules are now injected at build time rather than exposed through reviewer-sensitive runtime-loader source patterns. Promise-capable modal callbacks now use explicit fire-and-forget wrappers with logging. WebDAV/SFTP typing cleanup landed with the reviewer pass. |
| v2.9.0 | **Per-mount visible file-type filter** — mounts can now expose all files, Markdown only, or PDF only. **Android / BRAT load fix** — mobile-safe runtime loading and correct desktop dependency bundling. **Desktop watcher regression fix** — optional modules such as `chokidar` are bundled again correctly. **Suppressed watcher restart fix** — startup replay now respects watcher suppression state. |
| v2.3.0 | **Read-only toggle per mount** — a lock/unlock icon button on every mount row in Settings lets you flip read-only without opening the edit modal; amber tint when locked. **Toggle read-only on all mounts** command — one hotkey-assignable action to lock/unlock every mount on this device. **Toggle read-only on a specific mount…** command — fuzzy picker showing each mount’s current lock state, hotkey-assignable. |
| v2.2.0 | **Multi-select browse for ignore list** — the Browse… button in the per-mount ignore list opens the OS folder picker with multi-selection enabled; all chosen folders are added in one save + vault-reload. |
| v2.1.0 | **Read-only mount graceful handling** — write operations through read-only mounts are now silently swallowed and surface a one-time `Notice` instead of throwing (fixes editor crash loop on auto-save). **VirtualAdapter vault name** — `getName()` now delegates to the underlying adapter instead of returning the hardcoded string `'VirtualAdapter'` (fixes vault name showing incorrectly in the lower-left UI). |
| v2.0.0+ | **Official Obsidian community plugin directory** — listed in the Obsidian plugin browser; install directly via Settings → Community Plugins → Browse. |
| v2.0.0 | **S3 / Backblaze B2 mounts** — mount any S3-compatible bucket (Amazon S3, Backblaze B2, MinIO, Cloudflare R2) as a virtual vault folder with quick-fill presets, OS-keychain-encrypted secret key, and correct ListObjectsV2 virtual-folder semantics. **SFTP mounts** — mount any remote SSH directory (password or private-key auth); persistent auto-reconnecting connection per mount; server-side atomic rename. Generalised `CredentialStore` with generic encrypt/decrypt helpers. Mobile UI shows WebDAV and S3/B2 only. Export/import strips all credential types. `SecurityManager` skips local-path checks for cloud mounts. |
| v1.1.6 | Command palette integration — four commands: Add mount, Toggle mount on/off (fuzzy picker), Reconnect unreachable mounts, Open settings. All assignable to custom hotkeys. |
| v1.1.5 | First-run onboarding welcome modal — shown once to new users with no mounts configured; direct "Add my first mount →" action. |
| v1.1.4 | Import / Export mount configuration — export strips credentials; import appends mounts with fresh IDs. |
| v1.1.3 | WebDAV connection presets — quick-fill for Nextcloud, ownCloud, Synology NAS, QNAP NAS. |
| v1.1.2 | Global ignore patterns — a single pattern list applied across every mount before per-mount rules. |
| v1.1.1 | Persistent WebDAV credentials — OS keychain (DPAPI / macOS Keychain / libsecret) via Electron `safeStorage`; device-specific encrypted blob safe to sync; transparent session-memory fallback on mobile. |
| v1.1.0 | Android / mobile support — WebDAV mounts work on Obsidian Android; UI auto-adapts to mobile-only mode. Configurable image/PDF data: URI size cap (setting). |
| v1.0.0 | Stable release milestone; full README and documentation update. |
| v0.9.0 | Vault-to-vault bridging — mount another vault's folder; auto-ignores `.obsidian`, `.trash`, `.smart-connections`. |
| v0.8.0 | WebDAV support (Nextcloud, ownCloud, generic); health checks via HTTP `exists()` probe; no file watcher for HTTP mounts. |
| v0.7.0 | Per-mount debounce threshold; per-mount polling mode; max-files scan limit; Advanced settings collapsible section. |
| v0.6.0 | Conflict resolution UI — 30s background health checks, orange status bar on unreachable mounts, per-mount reconnect button. |
| v0.5.0 | Edit mount in-place; drag-drop reorder in settings; "Move mount to…" context menu; Browse-to-ignore picker; path-relative ignore patterns; instant file-explorer refresh on ignore add. |
| v0.4.3 | Image/PDF rendering via `data:` URIs; rename race fix; OneDrive cloud placeholder detection; PathMapper O(N) lookup cache. |
| v0.4.2 | FileWatcher hardening — symlink escape fix, watcher restart, 20 unit tests. |
| v0.2.0 | Device-specific mount IDs, foreign mount toggle, path overrides, ignore list, context menu integration. |
| v0.1.0 | Initial release — VirtualAdapter, PathMapper, SecurityManager, Windows hardening, browse buttons, WSL hints. |

---

## Planned Features

### High Priority

- **macOS verified support** — POSIX code paths are implemented and believed to work; a confirmed macOS test pass + community feedback loop would let us mark it ✅ Stable
- **S3 / SFTP connection presets** — quick-fill dropdowns for common SFTP hosts and S3-compatible providers, matching the WebDAV preset UX

### Medium Priority

- **Mounted-folder sort modes / file organisation** — add explicit ordering controls for bridged folders without trying to replace Obsidian's file explorer UI.
	- **Phase 1: low-risk sort modes** — alphabetical ascending/descending, folders-first ordering, and extension/filetype ordering. These can likely be implemented in Folder Bridge's adapter listing path before results are returned to Obsidian.
	- **Phase 2: metadata sorts** — modified time and possibly size-based ordering. Feasible for local mounts, but more expensive for WebDAV/S3/SFTP because sorting may require extra metadata/stat calls for every entry.
	- **Phase 3: grouped explorer views (exploratory)** — Windows Explorer-style grouping such as “by file type” or “by date” would require deeper file-explorer UI integration rather than simple adapter ordering. Higher maintenance risk; only worth pursuing if simpler sort modes are not sufficient.
- **OAuth2-based Google Drive mounting** — requires a local HTTP redirect server for the auth callback; scoped to a future release once the core mount types stabilise
- **OneDrive OAuth2 mounting** — same auth-server requirement as Google Drive; UNC path workaround (`\\server\share`) works today for on-prem scenarios
- **Lazy / paginated directory listing** — for mounts with tens of thousands of files; currently capped at 10 000 entries via a hard limit
- **iOS feasibility re-evaluation** — track Obsidian's iOS plugin API changes; if Apple relaxes sandbox rules or Obsidian ships a network-mount abstraction, revisit

### Low Priority / Exploratory

- **Per-folder organization rules** — if sort modes prove useful, evaluate whether sort order should be configurable globally, per mount, or per bridged subtree. This is intentionally deferred until a simple sort implementation exists and performance characteristics are known.
- **Read-only HTTP/S static server** — serve a mounted folder as a local file server for lightweight in-vault sharing
- **Per-mount credential rotation UI** — re-enter or rotate credentials for a specific mount without removing and recreating it
- **Mount health dashboard** — dedicated view showing uptime, last-seen, and error history per mount
- **Encrypted local mounts** — transparent at-rest encryption layer for local folder mounts (research phase)

---

The roadmap evolves with community feedback and real-world usage patterns. To request a feature or report a platform-specific issue, open an issue on [GitHub](https://github.com/tescolopio/Obsidian_FolderBridge/issues).
