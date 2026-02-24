# Android Setup Guide

Access files and folders anywhere on your Android device from inside Obsidian using FolderBridge + a local WebDAV server app.

---

## How it works

Obsidian on Android is sandboxed — plugins cannot read files outside the vault directly. FolderBridge works around this by talking HTTP instead of touching the filesystem. A free Android app runs a WebDAV server on `localhost`, exposing your device's storage (Downloads, DCIM, Documents, any folder). FolderBridge connects to that local server and surfaces the files as a virtual folder inside your vault.

```
Obsidian (FolderBridge plugin)
  → HTTP  →  WebDAV server app (localhost:PORT)
               → Android storage (Downloads/, DCIM/, Documents/, etc.)
```

No internet connection required. Everything stays on-device.

---

## Step 1 — Install a WebDAV server app

### Recommended: CX File Explorer (free)

1. Install [CX File Explorer](https://play.google.com/store/apps/details?id=com.cxinventor.file.explorer) from the Play Store
2. Open CX File Explorer → tap **Network** (bottom bar) → **Remote Access**
3. Tap **Start** — note the address shown (e.g. `http://192.168.x.x:8888`)
4. The server runs while the app is open. For background operation, enable **Run in background** in the app's settings

> The address shown is your LAN IP. When connecting from the *same device*, use `http://localhost:8888` instead.

### Alternative: HTTP File Server

1. Install [HTTP File Server](https://play.google.com/store/apps/details?id=io.rclone.android) (or any app that exposes WebDAV on localhost)
2. Start the server and note the port

### Alternative: Solid Explorer (has built-in WebDAV server plugin)

Available via Solid Explorer's Plugin Store inside the app.

---

## Step 2 — Install FolderBridge (beta)

Until v1.1.0 is in the Community Plugins directory, install via BRAT:

1. Install **Obsidian42 - BRAT** from Community Plugins
2. BRAT Settings → **Add Beta Plugin**
3. Paste: `https://github.com/tescolopio/Obsidian_FolderBridge`
4. Enable the plugin

---

## Step 3 — Add a WebDAV mount in FolderBridge

1. Open Obsidian → **Settings → FolderBridge**
2. Tap **Add Mount**
3. Fill in the fields:

| Field | Value |
|-------|-------|
| **Mount type** | WebDAV *(only option on mobile — automatically selected)* |
| **WebDAV URL** | `http://localhost:8888/` *(adjust port to match your server app)* |
| **Username** | Leave blank, or enter credentials if you set them in the server app |
| **Password** | Same |
| **Virtual path** | The folder name that will appear in your vault, e.g. `Android Files` |

4. Tap **Save**
5. The mount appears in your vault's file explorer under the virtual path you chose

---

## Step 4 — Verify it works

- Open the vault file explorer — you should see your virtual folder
- Navigate into it — your Android Downloads (or whichever folder the server exposes) should be listed
- Open a file — it reads directly from the WebDAV server
- Create or edit a note — changes write back through the server to the real file

---

## Troubleshooting

### Mount shows "Offline" or connection refused
- Make sure the WebDAV server app is running (check its notification in the status bar)
- Confirm the port number matches what the app shows
- Try `http://127.0.0.1:PORT/` instead of `localhost` in case of DNS resolution issues
- Some server apps require you to grant storage permission — check the app's own settings

### Files appear but images don't load
- This is a known limitation when the server returns binary content without correct MIME types. Try a different server app, or check if the server app has a "serve static files" or "content type" setting.

### Server stops when Obsidian is in the foreground
- Android kills background apps aggressively. In your WebDAV server app, enable **"Keep running in background"** or add it to Android's battery optimization exclusion list:  
  Settings → Battery → App battery usage → [Server app] → Unrestricted

### I want to expose only a specific folder, not all storage
- Most server apps let you choose the root directory. Set it to e.g. `/sdcard/Documents/MyProject/` so only that folder is accessible via WebDAV.

---

## Server app comparison

| App | Free | Background | Credentials | Root dir control |
|-----|------|-----------|-------------|-----------------|
| CX File Explorer | ✅ | ✅ (setting) | Optional | ✅ |
| HTTP File Server | ✅ | ✅ | Optional | ✅ |
| Solid Explorer | Paid | ✅ | Optional | ✅ |
| WebDAV Server | ✅ | ✅ | Required | ✅ |

---

## Security note

The WebDAV server is bound to `localhost` by default in most apps, meaning only apps on the same device can connect to it. If you configure it to bind to `0.0.0.0` (all interfaces), it becomes accessible on your local network — useful if you also want to connect from your PC, but be sure to set credentials.
