<div align="center">

<img src="./docs/assets/zen-logo-plus.png" width="120" alt="Zen Browser ++ logo" style="border-radius: 24%;" />

# Zen Browser ++

**A premium, feature-rich fork of [Zen Browser](https://zen-browser.app/) with built-in, end-to-end encrypted sync.**

[![Based on Firefox](https://img.shields.io/badge/based%20on-Firefox%20152-ff7139.svg)](https://www.mozilla.org/firefox/)
[![License: MPL 2.0](https://img.shields.io/badge/license-MPL%202.0-orange.svg)](https://www.mozilla.org/MPL/2.0/)
[![Zen Sync](https://img.shields.io/badge/Zen%20Sync-E2E%20encrypted-success.svg)](https://github.com/limeflash/zen-sync)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-blue.svg)](#-building)

</div>

Zen Browser ++ builds on the privacy-first foundations of Mozilla Firefox and the
beautiful vertical-tab paradigm of Zen Browser, adding a polished, self-hostable
**sync** for your workspaces and tabs — encrypted on-device so the relay never
sees your data.

---

## ✨ Highlights

- **🔒 Zen Sync** — end-to-end encrypted sync of spaces, tabs, groups and folders
  across devices, against a **self-hostable** relay. See [limeflash/zen-sync](https://github.com/limeflash/zen-sync).
- **🪟 Redesigned sync setup** — an intuitive, localized (EN/RU) configuration
  pane with step-by-step device-pairing instructions.
- **🛟 Fail-safe account management** — connect, disconnect and switch accounts
  instantly, with robust error handling.
- **🎨 Modern, Fluent UI** — native settings cards, matching accent colors and
  refined spacing.
- **🛡️ Private by default** — your keys, salts and passphrase never leave the
  device in plaintext.

---

## 🔄 Zen Sync

The sync feature lives in its own repository — **[limeflash/zen-sync](https://github.com/limeflash/zen-sync)** —
and is consumed here as a git **submodule** at [`src/zen/sync`](src/zen/sync):

| Part | What it is |
| ---- | ---------- |
| **client** | The in-browser module (this repo, via the submodule): crypto, relay calls, conflict-safe reconciliation, and the settings pane. |
| **server** | A self-hostable, **zero-knowledge** FastAPI relay — stores only ciphertext. |

How it works (details in the sync repo's
[ARCHITECTURE](https://github.com/limeflash/zen-sync/blob/master/docs/ARCHITECTURE.md)
and [API](https://github.com/limeflash/zen-sync/blob/master/docs/API.md) docs):

1. A passphrase derives an **AES-256-GCM** key + auth token (PBKDF2, 100k iters).
2. Your state is encrypted on-device and pushed to **your** relay as opaque blobs.
3. Other devices pull and decrypt — the relay only ever sees ciphertext.

Run your own relay in minutes (Docker or `uvicorn`); see the
[server README](https://github.com/limeflash/zen-sync/tree/master/server). Then
open **Settings → Zen Sync**, enter your Relay URL + passphrase, and pair devices.

---

## 🛠️ Building

> Zen Browser ++ is a full Firefox fork — building it compiles the browser engine.

### Prerequisites
- **Node.js** v20+
- Mozilla's build toolchain — **[MozillaBuild](https://ftp.mozilla.org/pub/mozilla.org/mozilla/libraries/win32/MozillaBuild-Latest.exe)**
  on Windows; `mach bootstrap` on macOS/Linux.
- A Clang ≥ 19 toolchain (see [`configs/`](configs)).

### Clone (with the sync submodule)
```bash
git clone --recursive https://github.com/limeflash/zen-browser-plus
cd zen-browser-plus
# already cloned without --recursive?
git submodule update --init --recursive
```

### Build & run
```bash
npm install
npm run build        # full engine build (the first build takes a while)
npm run package      # produce an installer/package under engine/.../dist
npm start            # run the built browser
```
For UI-only iteration use `npm run build:ui`. Release builds for **Windows**,
**macOS (incl. arm64)** and **Linux** are produced by the workflows in
[`.github/workflows`](.github/workflows).

---

## 🙏 Acknowledgements

We stand on the shoulders of giants:

- **[Mozilla Firefox](https://www.mozilla.org/firefox/)** — the secure,
  privacy-first engine that powers the modern web.
- **[Zen Browser](https://zen-browser.app/)** — the beautiful, innovative
  vertical-tab desktop browser this fork builds upon.

---

## 📄 License

Licensed under the **[Mozilla Public License, v. 2.0](https://www.mozilla.org/MPL/2.0/)**.
