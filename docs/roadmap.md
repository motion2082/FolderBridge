# Roadmap for Folder Bridge

This document outlines upcoming enhancements and platform compatibility goals for the Folder Bridge Obsidian plugin.

## Planned Extensions

- **Virtual Path Management & Drag-Drop Reorganization** (high priority)
  - Allow users to edit or change the virtual path of an existing mount without recreating it.
  - Support drag-drop reordering of mounts in the settings UI for better organization.
  - Enable drag-drop moving of mounts within the vault file explorer (e.g., moving a mount from `Projects/Work` to `Archive/Work`).
  - This will provide UX parity with Obsidian's native folder management and reduce friction when reorganizing.

- **Android** (current priority)
  - Provide a lightweight APK or integration that allows Android devices to mount external or network folders directly into an Obsidian vault on mobile.
  - Focus on compatibility with USB drives, cloud-sync folders (Dropbox, Google Drive), and local storage.
  - Ensure bi‑directional sync so edits made in Obsidian reflect in the mounted directory and vice versa.

- **macOS**
  - Investigate using FUSE (macfuse) or native filesystem APIs to allow virtual mounts within a Vault on Mac.
  - Support both local and networked (SMB/AFP/Cloud) folders with transparent updating.
  - Package as a macOS-friendly plugin or helper binary if necessary.

- **iOS**
  - Explore iOS limitations around filesystem access; consider using Files App integrations or short‑cut based mounting.
  - Goal is seamless read/write access to external folders (e.g., iCloud Drive, external USB via Files app) within Obsidian.
  - Prioritize minimal permissions and offline capabilities.

- **Other Enhancements**
  - Improved UI for managing mounts and conflict resolution.
  - Performance tuning for large folder mirrors.
  - Additional platform-specific helpers (e.g. Windows network drive heuristics).
  - Plugin settings to control sync frequency, caching, and security policies.

---


the roadmap will evolve with community feedback and real‑world usage patterns.