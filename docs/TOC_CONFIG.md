# TOC Config Guide

Folder Bridge can read JSON TOC files that define mounts and ignore rules.

You can use this in two ways:

- Keep one managed TOC file that the Settings UI writes for you.
- Load one or more external TOC files that stay read-only in the UI.

This is the right setup when you want a durable source of truth for a larger mount layout, a shared workstation setup, or a config file you can sync and review outside Obsidian.

## What a TOC File Is

A TOC file is a JSON object with one top-level `mounts` array.

Each object inside `mounts` becomes one Folder Bridge mount when the plugin loads.

Current scope:

- Only JSON is supported.
- Only `local` and `vault` mount types are supported in TOC files.
- One managed TOC file can be writable from the Settings UI.
- Additional external TOC files stay read-only in the Settings UI.
- Credentials are not supported in TOC files.
- You can configure the managed TOC file and register additional external TOC files in **Settings → Folder Bridge**.

## Managed vs External TOC Files

Folder Bridge supports two TOC roles:

- Managed TOC file: an optional writable file used by the Settings UI for local and vault mounts. When this is configured, new local and vault mounts created in Settings are written there instead of `data.json`.
- External TOC files: additional authoritative files loaded at runtime. These mounts appear in Settings, but you edit them in their source file.

This gives you one editable JSON source for day-to-day UI-driven mounts without giving up the ability to load other declarative mount files.

### Quick onboarding flow

If you already built your mount list in Settings, you do not need to rebuild it by hand.

1. Open **Settings → Folder Bridge → Managed TOC file**.
2. Accept the suggested path or enter your own writable JSON path.
3. Click **Create from current UI mounts**.
4. Folder Bridge will create the file, bind the UI to it, and move your existing local/vault UI mounts into that file.

Cloud mounts such as WebDAV, S3, and SFTP remain in `data.json` because TOC files do not support credentials.

### Portable TOC paths with `{{vault}}`

The managed TOC path, its fallback path, and external TOC paths all accept the `{{vault}}` token, which expands to the vault's folder on whichever machine opens it. The suggested managed path is `{{vault}}/folderbridge.managed.json`.

Use this whenever the TOC file lives inside the vault: the same `data.json` then works for anyone you share the vault with, on Windows, macOS, or Linux, without carrying your own absolute vault path. Always write the token path with forward slashes.

If an existing setting points to an absolute path inside the current vault, Folder Bridge rewrites it to the `{{vault}}` form the next time the plugin loads. The resolved path on this device is shown under the setting.

## Minimal Shape

```json
{
  "version": 1,
  "mounts": [
    {
      "virtualPath": "Projects",
      "realPath": "/home/me/Projects"
    }
  ]
}
```

Required fields for each mount:

- `virtualPath`: where the mount appears inside the vault
- `realPath`: the actual source folder on disk

Optional fields:

- `label`
- `enabled`
- `readOnly`
- `mountType`: `local` or `vault`
- `ignore` or `ignoreList`
- `visibleFileFilter`
- `watcherDebounceMs`
- `watcherUsePolling`
- `watcherPollingIntervalMs`
- `watcherCreateFilter`
- `watcherSuppressAllEvents`
- `maxFiles`
- `deviceOverrides`

## Full Schema by Example

```json
{
  "version": 1,
  "mounts": [
    {
      "virtualPath": "Projects/Client A/Active",
      "realPath": "/srv/client-a",
      "label": "Client A active",
      "enabled": true,
      "readOnly": false,
      "mountType": "local",
      "ignoreList": [
        "node_modules",
        ".git",
        "dist",
        "tmp/cache"
      ],
      "visibleFileFilter": "markdown-only",
      "watcherDebounceMs": 750,
      "watcherUsePolling": true,
      "watcherPollingIntervalMs": 5000,
      "watcherCreateFilter": "markdown-only",
      "watcherSuppressAllEvents": true,
      "maxFiles": 25000,
      "deviceOverrides": {
        "laptop-1": "/Users/me/ClientA",
        "linux-box": "/mnt/data/client-a"
      }
    }
  ]
}
```

## Field Rules

### `virtualPath`

- Must be a string.
- Must not be empty.
- Should be a vault-relative path such as `Projects/Work`.
- Will be normalized to forward-slash form.
- Must not overlap another mount's `virtualPath`.

Examples:

- `Projects`
- `Projects/Client A`
- `Reference/Papers`

### `realPath`

- Must be a string.
- Must not be empty.
- For `local`, use an absolute filesystem path.
- For `vault`, point to the other vault's root directory.

Examples:

- Linux: `/home/me/Projects`
- macOS: `/Users/me/Documents/Reference`
- Windows: `C:\\Users\\Me\\Projects`
- WSL from Windows Obsidian: `\\\\wsl.localhost\\Ubuntu\\home\\me\\notes`

### `mountType`

Allowed values:

- `local`
- `vault`

If omitted, Folder Bridge uses `local`.

Not currently supported in TOC files:

- `webdav`
- `s3`
- `sftp`

### `ignore` and `ignoreList`

Both forms are accepted. Use one or the other.

- Plain names ignore matching leaves anywhere in the mount: `node_modules`
- Globs ignore leaf-name patterns: `*.tmp`
- Paths with `/` ignore a specific subtree: `vendor/cache`

Examples:

```json
"ignore": ["node_modules", ".git", "build", "vendor/cache", "*.tmp"]
```

### `deviceOverrides`

Use this when the same logical mount exists at different real paths on different machines.

```json
"deviceOverrides": {
  "laptop-1": "/Users/me/Projects",
  "workstation": "/mnt/storage/projects"
}
```

The keys must match Folder Bridge device IDs.

### Watcher and scan fields

These map directly to the advanced per-mount settings in the UI.

- `visibleFileFilter`: `all`, `markdown-only`, `pdf-only`
- `watcherDebounceMs`: number
- `watcherUsePolling`: boolean
- `watcherPollingIntervalMs`: number
- `watcherCreateFilter`: `all` or `markdown-only`
- `watcherSuppressAllEvents`: boolean
- `maxFiles`: number

## Recommended File Shapes

### 1. Small personal setup

Use one file with a short flat list.

```json
{
  "version": 1,
  "mounts": [
    { "virtualPath": "Projects", "realPath": "/home/me/Projects" },
    { "virtualPath": "Reference", "realPath": "/home/me/Reference", "readOnly": true }
  ]
}
```

### 2. Team or workstation setup

Group mounts by function and use labels plus ignore rules.

```json
{
  "version": 1,
  "mounts": [
    {
      "virtualPath": "Clients/Alpha",
      "realPath": "/srv/clients/alpha",
      "label": "Alpha",
      "ignoreList": ["node_modules", ".git", "dist"]
    },
    {
      "virtualPath": "Clients/Beta",
      "realPath": "/srv/clients/beta",
      "label": "Beta",
      "ignoreList": ["node_modules", ".git", "build"]
    }
  ]
}
```

### 3. Complex multi-device setup

Use nested virtual paths, device overrides, and watcher tuning.

```json
{
  "version": 1,
  "mounts": [
    {
      "virtualPath": "Projects/Client A/Active",
      "realPath": "/srv/client-a",
      "deviceOverrides": {
        "laptop-1": "/Users/me/ClientA",
        "linux-box": "/mnt/data/client-a"
      },
      "ignoreList": ["node_modules", "dist", "tmp/cache"],
      "watcherUsePolling": true,
      "watcherPollingIntervalMs": 5000,
      "watcherSuppressAllEvents": true,
      "maxFiles": 25000
    }
  ]
}
```

### 4. Vault-to-vault reference setup

```json
{
  "version": 1,
  "mounts": [
    {
      "virtualPath": "Reference/Research Vault",
      "realPath": "/home/me/ResearchVault",
      "mountType": "vault",
      "readOnly": true
    }
  ]
}
```

## Testing Complex File Structures

When building a large TOC file, validate it incrementally instead of dropping in a huge config all at once.

### Start small

1. Add one mount.
2. Confirm it appears in the file explorer.
3. Add one ignore rule.
4. Add the next mount.

### Test path overlap cases

These should be rejected or warned about:

- Duplicate `virtualPath`
- Parent-child virtual overlaps such as `Projects` and `Projects/ClientA`
- Empty paths
- Unsupported mount types

### Test directory-shape cases

Useful real-world cases to test:

- Flat project root with `node_modules`, `dist`, and `.git`
- Deep nested client folder tree
- Large archive with `maxFiles` set
- Network/NAS folder with polling enabled
- Vault-to-vault mount with read-only enabled
- Same logical mount on two devices with different `deviceOverrides`

### Parser test matrix

The automated parser tests currently cover:

- Simple local and vault mounts
- `ignore` and `ignoreList` alias handling
- Unsupported mount type rejection
- Empty path rejection
- Complex watcher and device override fields
- Whitespace normalization and cleanup of empty ignore entries

See [tests/TocConfig.test.ts](../tests/TocConfig.test.ts).

## Limitations

- TOC files are JSON only.
- Remote mounts are not yet supported in TOC files.
- External TOC mounts are not edited from the Settings UI.
- TOC files do not store secrets or credentials.
- Reordering in Settings is intended for manual mounts only; TOC-backed mounts follow their source file.

## Troubleshooting

### A TOC file loads no mounts

Check:

- The file is valid JSON.
- The top-level object contains `mounts`.
- Each entry has both `virtualPath` and `realPath`.
- No mount overlaps an existing manual or TOC-derived mount.

### A mount is shown but cannot be edited

That is expected for external TOC mounts. Managed TOC mounts remain editable from Settings because Folder Bridge writes changes back to the managed file for you.

### A path works on one machine but not another

Use `deviceOverrides` and confirm the device ID shown in Folder Bridge settings.

### Ignore rules do not behave as expected

Check whether you intended:

- a leaf-name rule like `node_modules`
- a glob like `*.tmp`
- a subtree path like `vendor/cache`

## Suggested Workflow

1. Use **Managed TOC file** if you want the Settings UI to stay your main editor for local and vault mounts.
2. Use **Create from current UI mounts** the first time if you already have a working setup.
3. Add **External TOC config files** for shared, reviewed, or machine-specific read-only mount definitions.
4. Keep secrets out of all TOC files.
5. Leave WebDAV, S3, and SFTP mounts in `data.json`.
